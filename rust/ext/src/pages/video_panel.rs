//! The side panel on a YouTube video: Gemini's takeaways (made when asked,
//! kept per video under `videoNotes`), timestamps that seek the video, and
//! Talk it through with Gemini, from the notes and where the video is.
//!
//! A notes request outlives the panel: leaving the video (another tab, the
//! next video) does not throw away a minute of Gemini's work; it is saved
//! when it lands, and a panel opened on that video meanwhile shows it
//! working. Only Cancel stops it.

use super::notes_view::NotesView;
use super::reader::talk::TalkPanel;
use super::sidebar::MicHelp;
use super::{use_settings, use_storage};
use crate::js::{from_js, now, wait};
use crate::voice::sleep_ms;
use crate::{chrome, gemini, store};
use js_sys::{Array, Object, Reflect};
use leptos::prelude::*;
use reader_core::voice_agent::Source;
use reader_core::youtube::{
    chapters, clip, merge, notes_document, notes_request, parse_notes, stamp, watch_url, Kind,
    Section, VideoNotes, CLIP_MAX,
};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use wasm_bindgen::JsValue;

/// A long lecture can take a minute or two.
const NOTES_TIMEOUT_MS: i32 = 300_000;
/// How often Talk learns where the video is.
const POSITION_EVERY_MS: i32 = 2_000;

thread_local! {
    /// Notes being made, by video id: when they started, and how to stop them.
    static IN_FLIGHT: RefCell<HashMap<String, (i64, web_sys::AbortController)>> = RefCell::default();
}

fn started(id: &str) -> Option<i64> {
    IN_FLIGHT.with(|m| m.borrow().get(id).map(|(t, _)| *t))
}

#[wasm_bindgen::prelude::wasm_bindgen(module = "/js/tab-video.mjs")]
extern "C" {
    #[wasm_bindgen(js_name = seekFn)]
    fn seek_fn() -> JsValue;
    #[wasm_bindgen(js_name = positionFn)]
    fn position_fn() -> JsValue;
    #[wasm_bindgen(js_name = infoFn)]
    fn info_fn() -> JsValue;
}

/// Runs `func` (one of js/tab-video.mjs) with `arg` in the tab's page, where the player is.
async fn in_tab(tab_id: i32, func: &JsValue, arg: JsValue) -> Option<JsValue> {
    let details = Object::new();
    let target = Object::new();
    Reflect::set(&target, &"tabId".into(), &tab_id.into()).ok()?;
    Reflect::set(&details, &"target".into(), &target).ok()?;
    Reflect::set(&details, &"world".into(), &"MAIN".into()).ok()?;
    Reflect::set(&details, &"func".into(), func).ok()?;
    Reflect::set(&details, &"args".into(), &Array::of1(&arg)).ok()?;
    let results = wait(chrome::scripting_execute_script(&details))
        .await
        .ok()?;
    Reflect::get(&Array::from(&results).get(0), &"result".into()).ok()
}

#[component]
pub fn VideoPanel(tab_id: i32, id: String, title: Signal<String>) -> impl IntoView {
    let (settings, _) = use_settings();
    let (all, loaded) = use_storage::<BTreeMap<String, VideoNotes>>("videoNotes");
    let id_ = id.clone();
    let notes = Memo::new(move |_| all.with(|m| m.get(&id_).cloned()));
    let no_key = Memo::new(move |_| settings.with(|s| s.gemini_key.is_empty()));
    // Seconds since these notes were asked for; None when nothing is being made.
    let working = RwSignal::new(None::<u32>);
    let error = RwSignal::new(String::new());
    let mode = RwSignal::new("notes");
    let position = RwSignal::new(0u32);
    let alive = StoredValue::new(true);
    // The part to take notes on, and what the page says about the video.
    let from = RwSignal::new(String::new());
    let to = RwSignal::new(String::new());
    let length = RwSignal::new(0u32);
    let chaps = RwSignal::new(Vec::<(u32, String)>::new());
    let load_info = move || {
        leptos::task::spawn_local(async move {
            let info = in_tab(tab_id, &info_fn(), JsValue::NULL)
                .await
                .and_then(|v| from_js::<Value>(v).ok())
                .unwrap_or_default();
            if alive.try_get_value() != Some(true) {
                return;
            }
            length.set(info["length"].as_u64().unwrap_or(0) as u32);
            chaps.set(chapters(info["description"].as_str().unwrap_or_default()));
        })
    };
    // Each loop runs only while its generation is current: restarting one
    // (Cancel then Take notes; Talk, Notes, Talk) never leaves two running.
    let ticker_gen = StoredValue::new(0u64);
    let position_gen = StoredValue::new(0u64);
    on_cleanup(move || alive.set_value(false));
    load_info();

    // Counts up while this video's notes are being made, here or by a panel
    // that has since closed.
    let tick = {
        let id = id.clone();
        move || {
            ticker_gen.update_value(|g| *g += 1);
            let mine = ticker_gen.get_value();
            let id = id.clone();
            leptos::task::spawn_local(async move {
                while alive.try_get_value() == Some(true)
                    && ticker_gen.try_get_value() == Some(mine)
                {
                    match started(&id) {
                        Some(t) => working.set(Some(((now() - t) / 1000).max(0) as u32)),
                        None => {
                            working.set(None);
                            return;
                        }
                    }
                    sleep_ms(1_000).await;
                }
            });
        }
    };
    let tick = StoredValue::new(tick);
    if started(&id).is_some() {
        tick.with_value(|f| f());
    }

    let (id2, title2) = (id.clone(), title);
    // `add`: the part joins the notes already kept instead of replacing them.
    let take = move |kind: Option<Kind>, add: bool| {
        let key = settings.get_untracked().gemini_key;
        if key.is_empty() || started(&id2).is_some() {
            return;
        }
        let part = match clip(
            &from.get_untracked(),
            &to.get_untracked(),
            length.get_untracked(),
        ) {
            Ok(None) if add => {
                error.set("Set From and To for the part to add.".into());
                return;
            }
            Ok(p) => p,
            Err(m) => {
                error.set(m);
                return;
            }
        };
        let Ok(c) = web_sys::AbortController::new() else {
            return;
        };
        let id = id2.clone();
        IN_FLIGHT.with(|m| m.borrow_mut().insert(id.clone(), (now(), c.clone())));
        error.set(String::new());
        tick.with_value(|f| f());
        let url = watch_url(&id);
        let title = title2.get_untracked();
        leptos::task::spawn_local(async move {
            let made = gemini::generate(
                &key,
                &notes_request(&url, kind, part),
                NOTES_TIMEOUT_MS,
                Some(c),
            )
            .await
            .and_then(|body| parse_notes(&body, &id, &url, &title, now()))
            .map(|mut n| {
                // A part's summary is the part's, kept with its range.
                n.sections = part
                    .map(|(from, to)| Section {
                        from,
                        to,
                        summary: std::mem::take(&mut n.summary),
                    })
                    .into_iter()
                    .collect();
                n
            });
            // Cancelled meanwhile: drop the result, say nothing.
            let ours = IN_FLIGHT.with(|m| m.borrow_mut().remove(&id)).is_some();
            if !ours {
                return;
            }
            match made {
                Ok(n) => {
                    // Read fresh: another panel may have saved notes meanwhile.
                    let mut saved: BTreeMap<String, VideoNotes> =
                        store::get("videoNotes").await.unwrap_or_default();
                    let n = match saved.remove(&id) {
                        Some(old) if add => merge(old, n),
                        _ => n,
                    };
                    saved.insert(id, n);
                    // The next part most likely starts where this one ended.
                    if let (true, Some((_, end))) = (alive.try_get_value() == Some(true), part) {
                        from.set(stamp(end));
                        to.set(String::new());
                    }
                    if store::set("videoNotes", &saved).await.is_err()
                        && alive.try_get_value() == Some(true)
                    {
                        error.set("Couldn't save the notes.".into());
                    }
                }
                Err(m) if alive.try_get_value() == Some(true) => error.set(m),
                Err(_) => {}
            }
            if alive.try_get_value() == Some(true) {
                working.set(None);
            }
        });
    };
    let take = StoredValue::new(take);
    let id3 = id.clone();
    let cancel = move |_| {
        if let Some((_, c)) = IN_FLIGHT.with(|m| m.borrow_mut().remove(&id3)) {
            c.abort();
        }
        working.set(None);
    };
    let seek = Callback::new(move |s: u32| {
        leptos::task::spawn_local(async move {
            let _ = in_tab(tab_id, &seek_fn(), s.into()).await;
        });
    });

    // While talking, keep the position fresh; one loop at a time.
    Effect::new(move |_| {
        position_gen.update_value(|g| *g += 1);
        if mode.get() != "talk" {
            return;
        }
        let mine = position_gen.get_value();
        leptos::task::spawn_local(async move {
            while alive.try_get_value() == Some(true) && position_gen.try_get_value() == Some(mine)
            {
                let t = in_tab(tab_id, &position_fn(), JsValue::NULL).await;
                if let Some(secs) = t
                    .and_then(|v| from_js::<Value>(v).ok())
                    .and_then(|v| v.as_f64())
                {
                    position.set(secs.max(0.0) as u32);
                }
                sleep_ms(POSITION_EVERY_MS).await;
            }
        });
    });

    let open_settings = move |_| {
        let _ = chrome::open_options_page();
    };
    let heading = move || {
        notes
            .with(|n| n.as_ref().map(|n| n.title.clone()))
            .unwrap_or_else(|| title.get())
    };

    let range = move || {
        view! {
            <Show when=move || { length.get() > CLIP_MAX }>
                <p class="sidebar-quiet">{move || format!("This video is {} long. Gemini watches up to {} at a time: pick the part to take notes on.", stamp(length.get()), stamp(CLIP_MAX))}</p>
            </Show>
            <div class="sidebar-range">
                <label>"From" <input type="text" inputmode="numeric" list="video-chapters" placeholder="0:00" prop:value=move || from.get() on:input=move |e| from.set(event_target_value(&e)) /></label>
                <label>"To" <input type="text" inputmode="numeric" list="video-chapters" placeholder={move || if length.get() > 0 { stamp(length.get()) } else { "end".into() }} prop:value=move || to.get() on:input=move |e| to.set(event_target_value(&e)) /></label>
            </div>
            <datalist id="video-chapters">
                {move || chaps.get().into_iter().map(|(t, label)| view! { <option value=stamp(t) label=label></option> }).collect_view()}
            </datalist>
        }
    };

    view! {
        <h1 class="sidebar-title">{heading}</h1>
        <Show when=move || no_key.get()>
            <p class="ai-note-error" role="alert">"Taking notes needs a Gemini key in Settings."</p>
            <button type="button" class="ghost-btn" on:click=open_settings>"Open Settings"</button>
        </Show>
        <Show when=move || error.with(|e| !e.is_empty())>
            <p class="ai-note-error" role="alert">{move || error.get()}</p>
        </Show>
        {move || working.get().map(|n| view! {
            <p class="sidebar-quiet">
                <span role="status">"Gemini is watching the video…"</span>
                <span aria-hidden="true">{format!(" {n} s")}</span>
            </p>
            <button type="button" class="ghost-btn" on:click=cancel.clone()>"Cancel"</button>
        })}
        {move || match (loaded.get(), notes.get()) {
            (false, _) => ().into_any(),
            (true, None) => view! {
                <p class="sidebar-quiet">"Gemini watches the video and writes takeaways shaped to it: lecture, tutorial or explainer."</p>
                {range}
                <button type="button" class="fc-primary-btn" disabled=move || working.get().is_some() on:click=move |_| take.with_value(|f| f(None, false))>"Take notes"</button>
            }.into_any(),
            (true, Some(n)) => {
                let kind = n.kind;
                let texts = Signal::stored(Some(vec![notes_document(&n)]));
                view! {
                    // The shape is fixed while talking: a new one would end the conversation.
                    <Show when=move || mode.get() == "notes">
                        <div class="sidebar-switch" role="group" aria-label="Notes shape">
                            {Kind::ALL.into_iter().map(|k| view! {
                                <button type="button" aria-pressed=(k == kind).to_string() disabled=move || working.get().is_some()
                                    on:click=move |_| if k != kind { take.with_value(|f| f(Some(k), false)) }>{k.label()}</button>
                            }).collect_view()}
                        </div>
                    </Show>
                    <div class="sidebar-switch" role="group" aria-label="Mode">
                        <button type="button" aria-pressed=move || (mode.get() == "notes").to_string() on:click=move |_| mode.set("notes")>"Notes"</button>
                        <button type="button" aria-pressed=move || (mode.get() == "talk").to_string() on:click=move |_| mode.set("talk")>"Talk it through"</button>
                    </div>
                    <Show when=move || mode.get() == "notes">
                        {range}
                        <button type="button" class="ghost-btn" disabled=move || working.get().is_some()
                            on:click=move |_| take.with_value(|f| f(Some(kind), true))>"Add notes for this part"</button>
                    </Show>
                    {move || if mode.get() == "notes" {
                        view! { <NotesView notes=n.clone() on_seek=Some(seek) /> }.into_any()
                    } else {
                        view! {
                            <TalkPanel title=Signal::stored(n.title.clone()) source=Source::Video page_texts=texts page=position.into() on_close=Callback::new(|_| {}) />
                            <MicHelp />
                        }.into_any()
                    }}
                }.into_any()
            }
        }}
    }
}
