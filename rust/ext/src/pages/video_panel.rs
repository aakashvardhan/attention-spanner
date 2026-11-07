//! The side panel on a YouTube video: Gemini's takeaways (made when asked,
//! kept per video under `videoNotes`), timestamps that seek the video, and
//! Talk it through with Gemini, from the notes and where the video is.

use super::notes_view::NotesView;
use super::reader::talk::TalkPanel;
use super::{use_settings, use_storage};
use crate::js::{from_js, now, wait};
use crate::voice::sleep_ms;
use crate::{chrome, gemini, store};
use js_sys::{Array, Object, Reflect};
use leptos::prelude::*;
use reader_core::voice_agent::Source;
use reader_core::youtube::{notes_document, notes_request, parse_notes, Kind, VideoNotes};
use serde_json::Value;
use std::collections::BTreeMap;
use wasm_bindgen::JsValue;

/// A long lecture can take a minute or two.
const NOTES_TIMEOUT_MS: i32 = 300_000;
/// How often Talk learns where the video is.
const POSITION_EVERY_MS: i32 = 2_000;

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
pub fn VideoPanel(tab_id: i32, id: String, url: String, title: String) -> impl IntoView {
    let (settings, _) = use_settings();
    let (all, loaded) = use_storage::<BTreeMap<String, VideoNotes>>("videoNotes");
    let id_ = id.clone();
    let notes = Memo::new(move |_| all.with(|m| m.get(&id_).cloned()));
    let working = RwSignal::new(None::<u32>);
    let error = RwSignal::new(String::new());
    let no_key = RwSignal::new(false);
    let mode = RwSignal::new("notes");
    let position = RwSignal::new(0u32);
    let ctl = StoredValue::new_local(None::<web_sys::AbortController>);
    let alive = StoredValue::new(true);
    on_cleanup(move || {
        alive.set_value(false);
        if let Some(c) = ctl.try_update_value(Option::take).flatten() {
            c.abort();
        }
    });

    let (id2, url2, title2) = (id.clone(), url.clone(), title.clone());
    let take = move |kind: Option<Kind>| {
        let key = settings.get_untracked().gemini_key;
        no_key.set(key.is_empty());
        if key.is_empty() {
            error.set("Taking notes needs a Gemini key in Settings.".into());
            return;
        }
        let Ok(c) = web_sys::AbortController::new() else {
            return;
        };
        ctl.set_value(Some(c.clone()));
        error.set(String::new());
        working.set(Some(0));
        leptos::task::spawn_local(async move {
            while alive.try_get_value() == Some(true) && working.get_untracked().is_some() {
                sleep_ms(1_000).await;
                working.update(|w| {
                    if let Some(n) = w {
                        *n += 1
                    }
                });
            }
        });
        let (id, url, title) = (id2.clone(), url2.clone(), title2.clone());
        leptos::task::spawn_local(async move {
            let made =
                gemini::generate(&key, &notes_request(&url, kind), NOTES_TIMEOUT_MS, Some(c))
                    .await
                    .and_then(|body| parse_notes(&body, &id, &url, &title, now()));
            if alive.try_get_value() != Some(true) {
                return;
            }
            working.set(None);
            match made {
                Ok(n) => {
                    // Read fresh: another tab may have saved notes meanwhile.
                    let mut saved: BTreeMap<String, VideoNotes> =
                        store::get("videoNotes").await.unwrap_or_default();
                    saved.insert(id, n);
                    if store::set("videoNotes", &saved).await.is_err() {
                        error.set("Couldn't save the notes.".into());
                    }
                }
                Err(m) => error.set(m),
            }
        });
    };
    let take = StoredValue::new(take);
    let cancel = move |_| {
        if let Some(c) = ctl.try_update_value(Option::take).flatten() {
            c.abort();
        }
        working.set(None);
    };
    let seek = Callback::new(move |s: u32| {
        leptos::task::spawn_local(async move {
            let _ = in_tab(tab_id, &seek_fn(), s.into()).await;
        });
    });

    // While talking, keep the position fresh; it stops with the panel or the mode.
    Effect::new(move |_| {
        if mode.get() != "talk" {
            return;
        }
        leptos::task::spawn_local(async move {
            while alive.try_get_value() == Some(true) && mode.get_untracked() == "talk" {
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
    let heading = {
        let title = title.clone();
        move || {
            notes.with(|n| {
                n.as_ref()
                    .map(|n| n.title.clone())
                    .unwrap_or_else(|| title.clone())
            })
        }
    };

    view! {
        <h1 class="sidebar-title">{heading}</h1>
        <Show when=move || error.with(|e| !e.is_empty())>
            <p class="ai-note-error" role="alert">{move || error.get()}</p>
            <Show when=move || no_key.get()>
                <button type="button" class="ghost-btn" on:click=open_settings>"Open Settings"</button>
            </Show>
        </Show>
        {move || working.get().map(|n| view! {
            <p class="sidebar-quiet" role="status">{format!("Gemini is watching the video… {n} s")}</p>
            <button type="button" class="ghost-btn" on:click=cancel>"Cancel"</button>
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
                    <div class="sidebar-switch" role="group" aria-label="Notes shape">
                        {Kind::ALL.into_iter().map(|k| view! {
                            <button type="button" aria-pressed=(k == kind).to_string() disabled=move || working.get().is_some()
                                on:click=move |_| if k != kind { take.with_value(|f| f(Some(k))) }>{k.label()}</button>
                        }).collect_view()}
                    </div>
                    <div class="sidebar-switch" role="group" aria-label="Mode">
                        <button type="button" aria-pressed=move || (mode.get() == "notes").to_string() on:click=move |_| mode.set("notes")>"Notes"</button>
                        <button type="button" aria-pressed=move || (mode.get() == "talk").to_string() on:click=move |_| mode.set("talk")>"Talk it through"</button>
                    </div>
                    {move || if mode.get() == "notes" {
                        view! { <NotesView notes=n.clone() on_seek=Some(seek) /> }.into_any()
                    } else {
                        view! {
                            <TalkPanel title=Signal::stored(n.title.clone()) source=Source::Video page_texts=texts page=position.into() on_close=Callback::new(|_| {}) />
                        }.into_any()
                    }}
                }.into_any()
            }
        }}
    }
}
