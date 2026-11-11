//! The side panel on a YouTube video: Gemini's takeaways (made when asked,
//! kept per video under `videoNotes`), timestamps that seek the video, and
//! Talk it through with Gemini, from the notes and where the video is.
//!
//! The worker makes the notes (worker/video_notes.rs), so a request outlives
//! the panel: closing it or leaving the video loses nothing, and a panel on
//! that video in any tab shows it working (`videoNotesJobs`). Only Cancel
//! stops it.

use super::notes_view::NotesView;
use super::reader::talk::TalkPanel;
use super::sidebar::MicHelp;
use super::{send, use_settings, use_storage};
use crate::chrome;
use crate::js::{from_js, now, wait};
use crate::voice::sleep_ms;
use js_sys::{Array, Object, Reflect};
use leptos::prelude::*;
use reader_core::voice_agent::Source;
use reader_core::youtube::{
    chapters, clip, notes_document, reshape_parts, stamp, Kind, NotesJob, VideoNotes, CLIP_MAX,
    NOTES_JOBS,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use wasm_bindgen::JsValue;

/// How often Talk learns where the video is.
const POSITION_EVERY_MS: i32 = 2_000;
/// The player may still be loading, or still on the last video, just after
/// a navigation: ask again this many times, half a second apart.
const INFO_TRIES: u32 = 10;

#[wasm_bindgen::prelude::wasm_bindgen(module = "/js/tab-video.mjs")]
extern "C" {
    #[wasm_bindgen(js_name = seekFn)]
    fn seek_fn() -> JsValue;
    #[wasm_bindgen(js_name = positionFn)]
    fn position_fn() -> JsValue;
    #[wasm_bindgen(js_name = infoFn)]
    fn info_fn() -> JsValue;
}

/// Runs `func` (one of js/tab-video.mjs or js/tab-mark.mjs) with `arg` in the tab's page, where the player is.
pub(super) async fn in_tab(tab_id: i32, func: &JsValue, arg: JsValue) -> Option<JsValue> {
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
    let (jobs, _) = use_storage::<BTreeMap<String, NotesJob>>(NOTES_JOBS);
    let id_j = id.clone();
    let job = Memo::new(move |_| jobs.with(|m| m.get(&id_j).cloned()));
    let clock = RwSignal::new(now());
    // Seconds since these notes were asked for; None when nothing is being made.
    let working = Memo::new(move |_| {
        job.with(|j| {
            j.as_ref()
                .filter(|j| j.error.is_empty())
                .map(|j| ((clock.get() - j.started) / 1000).max(0) as u32)
        })
    });
    // Between a click and the worker's answer.
    let sending = RwSignal::new(false);
    let busy = move || sending.get() || working.get().is_some();
    let error = RwSignal::new(String::new());
    let shown_error = move || {
        let e = error.get();
        if e.is_empty() {
            job.with(|j| j.as_ref().map(|j| j.error.clone()).unwrap_or_default())
        } else {
            e
        }
    };
    let mode = RwSignal::new("notes");
    let position = RwSignal::new(0u32);
    let alive = StoredValue::new(true);
    // The part to take notes on, and what the page says about the video.
    let from = RwSignal::new(String::new());
    let to = RwSignal::new(String::new());
    let length = RwSignal::new(0u32);
    let chaps = RwSignal::new(Vec::<(u32, String)>::new());
    // Reads the player until it is on this video (it may still be loading,
    // or on the last one); a page with no id to report is taken at its word.
    let id_i = StoredValue::new(id.clone());
    // The player has said it is on this video: its length can be trusted.
    let verified = RwSignal::new(false);
    let load_info = move || async move {
        for _ in 0..INFO_TRIES {
            let info = in_tab(tab_id, &info_fn(), JsValue::NULL)
                .await
                .and_then(|v| from_js::<Value>(v).ok())
                .unwrap_or_default();
            if alive.try_get_value() != Some(true) {
                return;
            }
            let theirs = info["id"].as_str().unwrap_or_default();
            let len = info["length"].as_u64().unwrap_or(0) as u32;
            if (theirs.is_empty() || id_i.with_value(|id| id == theirs)) && len > 0 {
                verified.set(!theirs.is_empty());
                length.set(len);
                chaps.set(chapters(info["description"].as_str().unwrap_or_default()));
                return;
            }
            sleep_ms(500).await;
        }
    };
    // Each loop runs only while its generation is current (Talk, Notes, Talk
    // never leaves two running).
    let position_gen = StoredValue::new(0u64);
    on_cleanup(move || alive.set_value(false));
    leptos::task::spawn_local(load_info());
    leptos::task::spawn_local(async move {
        while alive.try_get_value() == Some(true) {
            clock.set(now());
            sleep_ms(1_000).await;
        }
    });
    // A part landed: the next one most likely starts where it ended.
    let last_end = Memo::new(move |_| {
        notes.with(|n| {
            n.as_ref()
                .and_then(|n| n.sections.iter().map(|s| s.to).max())
        })
    });
    Effect::new(move |_| {
        if let Some(end) = last_end.get() {
            from.set(stamp(end));
            to.set(String::new());
        }
    });

    let (id2, title2) = (id.clone(), title);
    // `kind` alone (no `add`) re-takes the kept notes in that shape, over the
    // same parts; `add` joins the From/To part to them; neither is the first take.
    let take = move |kind: Option<Kind>, add: bool| {
        if no_key.get_untracked() || sending.get_untracked() || working.get_untracked().is_some() {
            return;
        }
        sending.set(true);
        error.set(String::new());
        let id = id2.clone();
        let title = title2.get_untracked();
        let kept = notes.get_untracked();
        leptos::task::spawn_local(async move {
            let parts = match (&kept, kind, add) {
                (Some(n), Some(_), false) => Ok(reshape_parts(n)),
                _ => {
                    if !verified.get_untracked() {
                        load_info().await;
                        // The panel went (another video or tab) while the player was asked.
                        if alive.try_get_value() != Some(true) {
                            return;
                        }
                    }
                    match clip(
                        &from.get_untracked(),
                        &to.get_untracked(),
                        length.get_untracked(),
                    ) {
                        Ok(None) if add => Err("Set From and To for the part to add.".to_string()),
                        Ok(p) => Ok(vec![p]),
                        Err(m) => Err(m),
                    }
                }
            };
            let reply = match parts {
                Ok(parts) => {
                    send(json!({
                        "type": "VIDEO_NOTES_TAKE",
                        "id": id,
                        "title": title,
                        "kind": kind,
                        "parts": parts,
                        "add": add,
                    }))
                    .await
                }
                Err(m) => json!({ "ok": false, "error": m }),
            };
            if alive.try_get_value() == Some(true) {
                if reply["ok"] != true {
                    error.set(reply["error"].as_str().unwrap_or("Couldn't start.").into());
                }
                sending.set(false);
            }
        });
    };
    let take = StoredValue::new(take);
    let id3 = id.clone();
    let cancel = move |_| {
        let id = id3.clone();
        leptos::task::spawn_local(async move {
            send(json!({ "type": "VIDEO_NOTES_CANCEL", "id": id })).await;
        });
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
        <Show when=move || !shown_error().is_empty()>
            <p class="ai-note-error" role="alert">{shown_error}</p>
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
                <button type="button" class="fc-primary-btn" disabled=busy on:click=move |_| take.with_value(|f| f(None, false))>"Take notes"</button>
            }.into_any(),
            (true, Some(n)) => {
                let kind = n.kind;
                let n_whole = n.sections.is_empty();
                let texts = Signal::stored(Some(vec![notes_document(&n)]));
                view! {
                    // The shape is fixed while talking: a new one would end the conversation.
                    <Show when=move || mode.get() == "notes">
                        <div class="sidebar-switch" role="group" aria-label="Notes shape">
                            {Kind::ALL.into_iter().map(|k| view! {
                                <button type="button" aria-pressed=(k == kind).to_string() disabled=busy
                                    on:click=move |_| if k != kind { take.with_value(|f| f(Some(k), false)) }>{k.label()}</button>
                            }).collect_view()}
                        </div>
                    </Show>
                    <div class="sidebar-switch" role="group" aria-label="Mode">
                        <button type="button" aria-pressed=move || (mode.get() == "notes").to_string() on:click=move |_| mode.set("notes")>"Notes"</button>
                        <button type="button" aria-pressed=move || (mode.get() == "talk").to_string() on:click=move |_| mode.set("talk")>"Talk it through"</button>
                    </div>
                    // Notes on the whole video have no parts to add to.
                    <Show when=move || mode.get() == "notes" && !n_whole>
                        {range}
                        <button type="button" class="ghost-btn" disabled=busy
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
