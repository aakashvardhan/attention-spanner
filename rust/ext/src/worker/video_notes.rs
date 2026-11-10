//! A video's notes are made here, not in the side panel: one worker serves
//! every tab, so a request outlives the panel that asked (closing it, or
//! another tab on the same video, does not lose or repeat a minute of
//! Gemini's work). Progress and failures are in `videoNotesJobs`, which every
//! panel watches; the notes are saved under the `videoNotes` lock.

use crate::js::{log_error, now, wait, Res};
use crate::voice::sleep_ms;
use crate::{chrome, gemini, store};
use reader_core::youtube::{
    add_part, as_part, merge, notes_request, parse_notes, watch_url, Kind, NotesJob, VideoNotes,
    NOTES_JOBS,
};
use serde_json::{json, Map, Value};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap};

/// A long lecture can take a minute or two, per part.
const NOTES_TIMEOUT_MS: i32 = 300_000;
/// Chrome stops a worker idle for 30 s; an extension call resets that clock.
const KEEPALIVE_MS: i32 = 20_000;

thread_local! {
    /// Requests running in this worker, by video id: a token (so a stopped
    /// request that settles late cannot pass for the next one) and its abort.
    static RUNNING: RefCell<HashMap<String, (u64, web_sys::AbortController)>> = RefCell::default();
    static NEXT: Cell<u64> = const { Cell::new(0) };
}

fn running(id: &str, token: u64) -> bool {
    RUNNING.with(|m| m.borrow().get(id).is_some_and(|(t, _)| *t == token))
}

/// Still current? Then it is done: forget it.
fn finish(id: &str, token: u64) -> bool {
    RUNNING.with(|m| {
        let mut m = m.borrow_mut();
        let ours = m.get(id).is_some_and(|(t, _)| *t == token);
        if ours {
            m.remove(id);
        }
        ours
    })
}

fn failed(error: &str) -> Value {
    json!({ "ok": false, "error": error })
}

/// Sets (or, with None, clears) one video's entry in `videoNotesJobs`.
async fn set_job(id: String, job: Option<NotesJob>) -> Res<()> {
    store::with_lock(NOTES_JOBS, async move {
        let mut jobs: BTreeMap<String, NotesJob> = store::get(NOTES_JOBS).await?;
        match job {
            Some(j) => jobs.insert(id, j),
            None => jobs.remove(&id),
        };
        store::set(NOTES_JOBS, &jobs).await
    })
    .await
}

/// Jobs left by an earlier worker died with it.
pub async fn clear_jobs() -> Res<()> {
    store::remove(&[NOTES_JOBS.to_string()]).await
}

pub async fn take(
    id: String,
    title: String,
    kind: Option<Kind>,
    parts: Vec<Option<(u32, u32)>>,
    add: bool,
) -> Value {
    let key = store::settings()
        .await
        .map(|s| s.gemini_key)
        .unwrap_or_default();
    if key.is_empty() {
        return failed("Taking notes needs a Gemini key in Settings.");
    }
    if parts.is_empty() {
        return failed("Nothing to take notes on.");
    }
    // Check and claim with no await between: two panels cannot both start.
    if RUNNING.with(|m| m.borrow().contains_key(&id)) {
        return failed("Notes for this video are already being made.");
    }
    let Ok(controller) = web_sys::AbortController::new() else {
        return failed("Couldn't start.");
    };
    let token = NEXT.with(|n| {
        n.set(n.get() + 1);
        n.get()
    });
    RUNNING.with(|m| {
        m.borrow_mut()
            .insert(id.clone(), (token, controller.clone()))
    });
    let job = NotesJob {
        started: now(),
        error: String::new(),
    };
    if set_job(id.clone(), Some(job)).await.is_err() {
        finish(&id, token);
        return failed("Couldn't start.");
    }
    keep_alive(id.clone(), token);
    wasm_bindgen_futures::spawn_local(run(id, title, key, kind, parts, add, token, controller));
    json!({ "ok": true })
}

pub async fn cancel(id: String) -> Value {
    if let Some((_, c)) = RUNNING.with(|m| m.borrow_mut().remove(&id)) {
        c.abort();
    }
    match set_job(id, None).await {
        Ok(()) => json!({ "ok": true }),
        Err(_) => failed("Couldn't cancel."),
    }
}

fn keep_alive(id: String, token: u64) {
    wasm_bindgen_futures::spawn_local(async move {
        loop {
            sleep_ms(KEEPALIVE_MS).await;
            if !running(&id, token) {
                return;
            }
            let _ = wait(chrome::runtime_get_platform_info()).await;
        }
    });
}

#[allow(clippy::too_many_arguments)]
async fn run(
    id: String,
    title: String,
    key: String,
    kind: Option<Kind>,
    parts: Vec<Option<(u32, u32)>>,
    add: bool,
    token: u64,
    controller: web_sys::AbortController,
) {
    let url = watch_url(&id);
    let mut made: Option<VideoNotes> = None;
    let mut error = None;
    for part in parts {
        let one = gemini::generate(
            &key,
            &notes_request(&url, kind, part),
            NOTES_TIMEOUT_MS,
            Some(controller.clone()),
        )
        .await
        .and_then(|body| parse_notes(&body, &id, &url, &title, now()))
        .map(|n| as_part(n, part));
        match one {
            Ok(n) => {
                made = Some(match made.take() {
                    Some(m) => merge(m, n),
                    None => n,
                })
            }
            Err(e) => {
                error = Some(e);
                break;
            }
        }
    }
    // Cancelled, or replaced by a newer request: say and save nothing.
    if !finish(&id, token) {
        return;
    }
    let outcome = match (error, made) {
        (Some(e), _) => Err(e),
        (None, Some(n)) => save(id.clone(), n, add).await,
        (None, None) => Err("Nothing to take notes on.".into()),
    };
    let job = outcome.err().map(|error| NotesJob {
        started: now(),
        error,
    });
    if let Err(e) = set_job(id, job).await {
        log_error("[worker] video notes", &e);
    }
}

/// Saves under the lock; a read that fails or finds no map stops the save
/// instead of writing back a map holding only this video.
async fn save(id: String, n: VideoNotes, add: bool) -> Result<(), String> {
    store::with_lock("videoNotes", async move {
        let mut saved: Map<String, Value> = match store::get::<Value>("videoNotes").await {
            Ok(Value::Object(m)) => m,
            Ok(Value::Null) => Map::new(),
            _ => return Err("Couldn't read the saved notes, so nothing was changed.".to_string()),
        };
        let n = if add {
            let old = saved
                .get(&id)
                .cloned()
                .and_then(|v| serde_json::from_value::<VideoNotes>(v).ok());
            add_part(old, n)?
        } else {
            n
        };
        saved.insert(
            id,
            serde_json::to_value(n).map_err(|_| "Couldn't save the notes.".to_string())?,
        );
        store::set("videoNotes", &saved)
            .await
            .map_err(|_| "Couldn't save the notes.".to_string())
    })
    .await
}
