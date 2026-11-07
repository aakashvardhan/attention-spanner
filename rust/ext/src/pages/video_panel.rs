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
    notes_document, notes_request, parse_notes, watch_url, Kind, VideoNotes,
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
    // Each loop runs only while its generation is current: restarting one
    // (Cancel then Take notes; Talk, Notes, Talk) never leaves two running.
    let ticker_gen = StoredValue::new(0u64);
    let position_gen = StoredValue::new(0u64);
    on_cleanup(move || alive.set_value(false));

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
    let take = move |kind: Option<Kind>| {
        let key = settings.get_untracked().gemini_key;
        if key.is_empty() || started(&id2).is_some() {
            return;
        }
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
            let made =
                gemini::generate(&key, &notes_request(&url, kind), NOTES_TIMEOUT_MS, Some(c))
                    .await
                    .and_then(|body| parse_notes(&body, &id, &url, &title, now()));
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
                    saved.insert(id, n);
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
                <button type="button" class="fc-primary-btn" disabled=move || working.get().is_some() on:click=move |_| take.with_value(|f| f(None))>"Take notes"</button>
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
                                    on:click=move |_| if k != kind { take.with_value(|f| f(Some(k))) }>{k.label()}</button>
                            }).collect_view()}
                        </div>
                    </Show>
                    <div class="sidebar-switch" role="group" aria-label="Mode">
                        <button type="button" aria-pressed=move || (mode.get() == "notes").to_string() on:click=move |_| mode.set("notes")>"Notes"</button>
                        <button type="button" aria-pressed=move || (mode.get() == "talk").to_string() on:click=move |_| mode.set("talk")>"Talk it through"</button>
                    </div>
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
