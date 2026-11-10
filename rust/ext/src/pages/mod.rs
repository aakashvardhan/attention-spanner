//! The extension's pages, in Leptos. Each keeps the React version's markup
//! (element for element, class for class) so the same stylesheets draw it the
//! same way: the screenshot baselines are the check.

pub mod ai;
pub mod blocked;
pub mod dumps;
pub mod lexicon;
pub mod newtab;
pub mod notes;
pub mod notes_view;
pub mod options;
pub mod papers;
pub mod reader;
pub mod sidebar;
mod todo_drag;
pub mod video_panel;

use crate::chrome;
use crate::js::{from_js, to_js, wait};
use leptos::prelude::*;
use serde::de::DeserializeOwned;
use serde_json::Value;
use wasm_bindgen::prelude::*;

/// A storage key as a signal: `(value, loaded)`. Starts at the default, fills
/// in once read, and follows every later change (another tab, the worker).
/// The default stands in for a missing key, as the TS `useStorageValue` did.
/// The listener is removed when the calling component is cleaned up.
pub fn use_storage<T>(key: &'static str) -> (ReadSignal<T>, ReadSignal<bool>)
where
    T: DeserializeOwned + Default + Clone + Send + Sync + 'static,
{
    let (value, set_value) = signal(T::default());
    let (loaded, set_loaded) = signal(false);
    let parse = |v: Option<Value>| {
        v.and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    };
    leptos::task::spawn_local(async move {
        if let Ok(v) = crate::store::get::<Value>(key).await {
            set_value.set(parse((!v.is_null()).then_some(v)));
        }
        set_loaded.set(true);
    });
    let listener =
        Closure::<dyn FnMut(JsValue, JsValue)>::new(move |changes: JsValue, area: JsValue| {
            if area.as_string().as_deref() != Some("local") {
                return;
            }
            let changes: Value = from_js(changes).unwrap_or_default();
            if let Some(change) = changes.get(key) {
                set_value.set(parse(change.get("newValue").cloned()));
            }
        });
    chrome::on_storage_changed(&listener);
    // Gone with its component: the side panel rebuilds its panels for every
    // tab and video, and a leaked listener would re-parse every later write.
    // (A page's root never cleans up; its listener lives as long as the page.)
    let listener = StoredValue::new_local(Some(listener));
    on_cleanup(move || {
        if let Some(l) = listener.try_update_value(Option::take).flatten() {
            chrome::off_storage_changed(&l);
        }
    });
    (value, loaded)
}

/// Settings merged over the defaults (the TS `useSettings`).
pub fn use_settings() -> (Signal<reader_core::types::Settings>, ReadSignal<bool>) {
    let (raw, loaded) = use_storage::<Value>("settings");
    let merged = Signal::derive(move || {
        let mut base =
            serde_json::to_value(reader_core::types::Settings::default()).unwrap_or_default();
        if let (Some(b), Value::Object(over)) = (base.as_object_mut(), raw.get()) {
            b.extend(over);
        }
        serde_json::from_value(base).unwrap_or_default()
    });
    (merged, loaded)
}

/// The palettes in theme.css, as (data-theme value, label). "paper" is the
/// unattributed default.
pub const THEMES: [(&str, &str); 6] = [
    ("grid", "Grid (dark, neon)"),
    ("paper", "Paper"),
    ("daylight", "Daylight (highest contrast)"),
    ("mist", "Mist"),
    ("graphite", "Graphite"),
    ("rose", "Rose"),
];

/// Follow the saved palette: sets html[data-theme], live across tabs. Once
/// the saved one is drawn, html[data-settled] lets theme changes ease in.
pub fn use_theme() {
    let (settings, loaded) = use_settings();
    Effect::new(move |_| {
        let theme = settings.get().theme;
        let Some(root) = web_sys::window()
            .and_then(|w| w.document())
            .and_then(|d| d.document_element())
        else {
            return;
        };
        let _ = if theme == "paper" {
            root.remove_attribute("data-theme")
        } else {
            root.set_attribute("data-theme", &theme)
        };
        if loaded.get() && !root.has_attribute("data-settled") {
            // Two frames: the palette must be styled before transitions turn on.
            request_animation_frame(move || {
                request_animation_frame(move || {
                    let _ = root.set_attribute("data-settled", "");
                })
            });
        }
    });
}

/// The reader asked the system for less motion.
pub fn reduced_motion() -> bool {
    window()
        .match_media("(prefers-reduced-motion: reduce)")
        .ok()
        .flatten()
        .is_some_and(|m| m.matches())
}

/// Run a change to the page inside a view transition, so what leaves can
/// animate out as well as what arrives animates in. Without the API, or under
/// Reduce Motion, the change just runs.
pub fn transition(f: impl FnOnce() + 'static) {
    use wasm_bindgen::JsCast;
    let doc = document();
    let start = js_sys::Reflect::get(&doc, &"startViewTransition".into())
        .ok()
        .and_then(|v| v.dyn_into::<js_sys::Function>().ok())
        .filter(|_| !reduced_motion());
    let Some(start) = start else {
        f();
        return;
    };
    let mut f = Some(f);
    let update = Closure::once_into_js(move || -> js_sys::Promise {
        if let Some(f) = f.take() {
            f();
        }
        // Leptos draws the change on a later microtask; the "after" picture waits for it.
        js_sys::Promise::new(&mut |resolve, _| {
            set_timeout(
                move || {
                    let _ = resolve.call0(&JsValue::NULL);
                },
                std::time::Duration::ZERO,
            );
        })
    });
    // A transition cut short by the next one rejects its `ready`; that is
    // not an error, so it must not surface as an unhandled rejection.
    if let Some(ready) = start
        .call1(&doc, &update)
        .ok()
        .and_then(|vt| js_sys::Reflect::get(&vt, &"ready".into()).ok())
        .and_then(|p| p.dyn_into::<js_sys::Promise>().ok())
    {
        leptos::task::spawn_local(async move {
            let _ = wasm_bindgen_futures::JsFuture::from(ready).await;
        });
    }
}

/// Send a message to the worker; the reply as JSON (`{ ok: false }` on failure).
pub async fn send(msg: Value) -> Value {
    let Ok(js) = to_js(&msg) else {
        return serde_json::json!({ "ok": false });
    };
    match wait(chrome::send_message(&js)).await {
        Ok(reply) => from_js(reply).unwrap_or_default(),
        Err(_) => serde_json::json!({ "ok": false }),
    }
}

/// Write one settings field, merged over what is stored.
pub async fn patch_settings(field: &str, value: Value) {
    let mut settings: Value = crate::store::get("settings").await.unwrap_or_default();
    if !settings.is_object() {
        settings = serde_json::json!({});
    }
    settings[field] = value;
    let _ = crate::store::set("settings", &settings).await;
}

/// The game (`reader_core::game`), live: it follows every key it is derived
/// from, and the minutes of a session still running count as they pass. The
/// second signal is what was just earned ("+30 XP"), shown for a few seconds.
pub fn use_game() -> (Memo<reader_core::game::Game>, ReadSignal<Option<String>>) {
    use crate::js::{local_date, now};
    use reader_core::game::{build, gain, Game};
    use reader_core::pomodoro::{Phase, Pomodoro};
    let (log, l1) = use_storage::<reader_core::activity::ActivityLog>("activity");
    let (explains, l2) = use_storage::<reader_core::explain::ExplainBacks>("explainBacks");
    let (lexicon, l3) = use_storage::<reader_core::lexicon::Lexicon>("lexicon");
    let (papers, l4) = use_storage::<Vec<reader_core::types::Paper>>("papers");
    let (todos, l5) = use_storage::<Vec<reader_core::todos::Todo>>("todos");
    let (session, l6) = use_storage::<Option<reader_core::types::FocusSession>>("focusSession");
    let (pomodoro, l7) = use_storage::<Option<Pomodoro>>("pomodoro");
    let tick = RwSignal::new(now());
    set_interval(move || tick.set(now()), std::time::Duration::from_secs(30));
    let game = Memo::new(move |_| {
        let t = tick.get();
        let since = |start: i64| ((t - start) / 60_000).max(0) as u32;
        let live = session.with(|s| s.as_ref().map_or(0, |s| since(s.started_at)))
            + pomodoro.with(|p| {
                p.as_ref()
                    .filter(|p| p.phase == Phase::Focus)
                    .map_or(0, |p| since(p.started_at))
            });
        build(
            &log.get(),
            &explains.get(),
            &lexicon.get(),
            &papers.get(),
            &todos.get(),
            live,
            local_date(t),
            local_date,
        )
    });
    let (earned, set_earned) = signal(None::<String>);
    // Nothing is "earned" while storage is still answering: that is just loading.
    Effect::new(move |prev: Option<Option<Game>>| {
        let next = game.get();
        if ![l1, l2, l3, l4, l5, l6, l7].iter().all(|l| l.get()) {
            return None;
        }
        if let Some(message) = prev.flatten().and_then(|p| gain(&p, &next)) {
            set_earned.set(Some(message.clone()));
            set_timeout(
                move || {
                    // A newer message keeps its own time.
                    set_earned.try_update(|m| {
                        if m.as_deref() == Some(&message) {
                            *m = None;
                        }
                    });
                },
                std::time::Duration::from_secs(5),
            );
        }
        Some(next)
    });
    (game, earned)
}
