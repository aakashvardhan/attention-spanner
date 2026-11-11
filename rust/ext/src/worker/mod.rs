//! The background service worker. `worker.js` registers every Chrome listener
//! synchronously (MV3 only delivers a waking event to listeners registered in
//! the worker's first turn) and forwards each event here once wasm is ready.

mod alphaxiv;
mod browser;
mod pdf_rules;
mod session;
mod video_notes;

use crate::chrome;
use crate::js::{from_js, log_error, now, to_js, wait, Res};
use crate::store;
use reader_core::activity::ActivityEvent;
use reader_core::annotations::{
    add_annotation, delete_annotation, move_annotation, update_annotation,
};
use reader_core::constants::{RETIRED_ALARMS, RETIRED_ALARM_PREFIXES, SYNC_ALARM};
use reader_core::messages::Message;
use reader_core::migrations::migrate;
use reader_core::pomodoro::POMODORO_ALARM;
use reader_core::reader_progress::{apply_reader_progress, ReaderPosition};
use reader_core::todos::{alarms_due, Todo, TODO_ALARM_PREFIX};
use reader_core::types::{Annotation, Paper};
use serde::Deserialize;
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

/// Runs a handler, logging (not throwing) failures: a listener that throws
/// only spams the console, and every handler is safe to run again.
async fn guarded(context: &str, f: impl std::future::Future<Output = Res<()>>) {
    if let Err(e) = f.await {
        log_error(context, &e);
    }
}

#[wasm_bindgen]
pub async fn on_installed() {
    guarded("[worker] install", async {
        let plan = migrate(&store::snapshot().await?, now(), chrome::random_uuid);
        store::session_remove(&plan.session_remove).await?;
        if !plan.remove.is_empty() {
            store::remove(&plan.remove).await?;
        }
        if !plan.set.is_empty() {
            store::set_many(&plan.set).await?;
        }
        clear_retired_alarms().await?;
        session::remove_legacy_daily_gate_rule().await?;
        session::reconcile_session().await?;
        browser::create_menus().await
    })
    .await;
}

#[wasm_bindgen]
pub async fn on_command(name: String) {
    guarded("[worker] command", browser::command(&name)).await;
}

#[wasm_bindgen]
pub async fn on_menu(info: JsValue, tab: JsValue) {
    guarded("[worker] menu", browser::menu_clicked(info, tab)).await;
}

#[wasm_bindgen]
pub async fn omnibox_suggest(text: String) -> JsValue {
    browser::omnibox_suggest(&text)
        .await
        .unwrap_or_else(|_| js_sys::Array::new().into())
}

#[wasm_bindgen]
pub async fn omnibox_url(text: String) -> String {
    browser::omnibox_url(&text)
        .await
        .unwrap_or_else(|_| chrome::get_url(reader_core::constants::PAPERS_PAGE_PATH))
}

#[wasm_bindgen]
pub async fn on_startup() {
    guarded("[worker] startup", async {
        session::remove_legacy_daily_gate_rule().await?;
        session::reconcile_session().await
    })
    .await;
}

/// Every worker start, not just install or browser start: session rules
/// outlive the worker but not the browser.
#[wasm_bindgen]
pub async fn on_worker_start() {
    guarded("[worker] start", async {
        // First, before a message can start a new job.
        video_notes::clear_jobs().await?;
        session::remove_legacy_daily_gate_rule().await?;
        session::reconcile_session().await?;
        pdf_rules::sync_pdf_rules().await
    })
    .await;
}

#[derive(Deserialize)]
struct Alarm {
    name: String,
}

async fn clear_retired_alarms() -> Res<()> {
    for name in RETIRED_ALARMS {
        wait(chrome::alarms_clear(name)).await?;
    }
    let all: Vec<Alarm> = from_js(wait(chrome::alarms_get_all()).await?)?;
    for alarm in all
        .iter()
        .filter(|a| RETIRED_ALARM_PREFIXES.iter().any(|p| a.name.starts_with(p)))
    {
        wait(chrome::alarms_clear(&alarm.name)).await?;
    }
    Ok(())
}

#[wasm_bindgen]
pub async fn on_alarm(name: String) {
    if name == SYNC_ALARM {
        alphaxiv::sync(false).await;
    } else if name == browser::BADGE_ALARM {
        guarded("[worker] badge", browser::refresh_badge()).await;
    } else if name == POMODORO_ALARM {
        guarded("[worker] pomodoro", session::pomodoro_alarm()).await;
    } else if let Some(id) = name.strip_prefix(TODO_ALARM_PREFIX) {
        guarded("[worker] reminder", remind(id)).await;
    }
}

/// A to-do's time came: say so, unless it was ticked off meanwhile.
async fn remind(id: &str) -> Res<()> {
    let todos: Vec<Todo> = store::get("todos").await?;
    let Some(todo) = todos.iter().find(|t| t.id == id && t.done_at.is_none()) else {
        return Ok(());
    };
    let options = to_js(&json!({
        "type": "basic",
        "iconUrl": chrome::get_url("icons/icon-128.png"),
        "title": "Reminder",
        "message": todo.text,
        "requireInteraction": true,
    }))?;
    wait(chrome::notifications_create(
        &format!("{TODO_ALARM_PREFIX}{id}"),
        &options,
    ))
    .await
    .map(drop)
}

/// Any edit to the list (add, retime, tick, delete) re-plans every reminder.
#[wasm_bindgen]
pub async fn on_todos_changed() {
    guarded("[worker] todos", async {
        let all: Vec<Alarm> = from_js(wait(chrome::alarms_get_all()).await?)?;
        for alarm in all.iter().filter(|a| a.name.starts_with(TODO_ALARM_PREFIX)) {
            wait(chrome::alarms_clear(&alarm.name)).await?;
        }
        let todos: Vec<Todo> = store::get("todos").await?;
        for (name, when) in alarms_due(&todos, now()) {
            wait(chrome::alarms_create(
                &name,
                &to_js(&json!({ "when": when }))?,
            ))
            .await?;
        }
        Ok(())
    })
    .await;
}

#[wasm_bindgen]
pub async fn on_pomodoro_changed() {
    guarded("[worker] pomodoro", session::pomodoro_changed()).await;
}

#[wasm_bindgen]
pub async fn on_settings_changed(old: JsValue, new: JsValue) {
    let blocklist = |v: JsValue| {
        from_js::<Value>(v)
            .ok()
            .map(|s| s["focusBlocklist"].clone())
    };
    let (old, new) = (blocklist(old), blocklist(new));
    if let Some(Value::Array(domains)) = new.clone().filter(|n| Some(n) != old.as_ref()) {
        let domains: Vec<String> = domains
            .iter()
            .filter_map(|d| d.as_str().map(str::to_string))
            .collect();
        guarded("[worker] blocklist", session::refresh_focus_rules(&domains)).await;
    }
}

/// A tab navigated: a reader tab that went elsewhere has left the session.
#[wasm_bindgen]
pub async fn on_tab_url(tab_id: i32, url: String) {
    guarded(
        "[worker] focus navigation",
        session::check_focus_navigation(tab_id, &url),
    )
    .await;
    if !session::is_reader_url(&url) {
        guarded("[worker] tab", session::reader_closed(tab_id)).await;
    }
}

#[wasm_bindgen]
pub async fn on_tab_removed(tab_id: i32) {
    guarded("[worker] tab", session::reader_closed(tab_id)).await;
}

/// One message from a page; resolves to the reply `sendResponse` gets.
#[wasm_bindgen]
pub async fn on_message(msg: JsValue, sender: JsValue) -> JsValue {
    let tab_id = from_js::<Value>(sender)
        .ok()
        .and_then(|s| s["tab"]["id"].as_i64())
        .map(|id| id as i32);
    let reply = match from_js::<Value>(msg)
        .ok()
        .and_then(|v| serde_json::from_value::<Message>(v).ok())
    {
        Some(message) => dispatch(message, tab_id).await.unwrap_or_else(|e| {
            log_error("[worker] message failed", &e);
            json!({ "ok": false })
        }),
        None => json!({ "ok": false, "error": "Unknown message." }),
    };
    to_js(&reply).unwrap_or(JsValue::NULL)
}

/// The Web Lock every read-modify-write of `papers` takes: the reader's
/// progress and the alphaXiv sync and shelf moves all rewrite the whole list.
const PAPERS_LOCK: &str = "papers";

/// One change to the annotation list, under a lock: a selection across two
/// pages sends two adds at once, and unlocked the second write drops the first.
async fn edit_annotations(
    f: impl FnOnce(&[Annotation]) -> Result<(Vec<Annotation>, Value), String> + 'static,
) -> Res<Value> {
    store::with_lock("annotations", async move {
        let list: Vec<Annotation> = store::get("annotations").await?;
        Ok(match f(&list) {
            Ok((next, reply)) => {
                store::set("annotations", &next).await?;
                reply
            }
            Err(error) => json!({ "ok": false, "error": error }),
        })
    })
    .await
}

async fn dispatch(message: Message, tab_id: Option<i32>) -> Res<Value> {
    Ok(match message {
        Message::ReaderOpened { title } => match tab_id {
            Some(id) => session::reader_opened(id, &title)
                .await
                .map(|()| json!({ "ok": true }))?,
            None => json!({ "ok": false }),
        },
        Message::FocusReader => json!({ "ok": session::focus_reader().await? }),
        Message::SessionCheck => {
            session::reconcile_session().await?;
            json!({ "ok": true })
        }
        Message::AlphaxivSignIn => alphaxiv::sign_in().await,
        Message::AlphaxivSignOut => alphaxiv::sign_out().await?,
        Message::AlphaxivSync { force } => alphaxiv::sync(force).await,
        Message::AlphaxivMove { paper_id, from, to } => {
            alphaxiv::move_paper(&paper_id, &from, &to).await
        }
        Message::AlphaxivSave {
            paper_id,
            folder_id,
        } => alphaxiv::save_paper(&paper_id, &folder_id).await,
        Message::AlphaxivArrivals => alphaxiv::arrivals().await,
        Message::PaperReaderProgress {
            paper_id,
            pdf_url,
            page,
            page_count,
            offset,
            left_off,
        } => {
            // Under the lock: the alphaXiv sync rewrites the same list.
            store::with_lock(PAPERS_LOCK, async move {
                let mut papers: Vec<Paper> = store::get("papers").await?;
                let Some(paper) = papers.iter_mut().find(|p| p.id == paper_id) else {
                    return Ok(json!({ "ok": false, "error": "Paper not found." }));
                };
                let t = now();
                if apply_reader_progress(
                    paper,
                    &ReaderPosition {
                        pdf_url,
                        page,
                        page_count,
                        offset,
                        left_off,
                    },
                    t,
                ) {
                    let touched = paper.last_read_at == Some(t);
                    store::set("papers", &papers).await?;
                    if touched {
                        session::log_activity(ActivityEvent::Paper(paper_id)).await?;
                    }
                }
                Res::Ok(json!({ "ok": true }))
            })
            .await?
        }
        Message::ReaderOpenNative { url } => match tab_id {
            Some(id) => pdf_rules::open_native_pdf(id, &url)
                .await
                .map(|()| json!({ "ok": true }))?,
            None => json!({ "ok": false }),
        },
        Message::AnnotAdd { draft } => {
            edit_annotations(move |list| {
                add_annotation(list, draft, chrome::random_uuid(), now())
                    .map(|(next, made)| (next, json!({ "ok": true, "annotation": made })))
            })
            .await?
        }
        Message::AnnotUpdate { id, patch } => {
            edit_annotations(move |list| {
                update_annotation(list, &id, patch, now()).map(|next| (next, json!({ "ok": true })))
            })
            .await?
        }
        Message::AnnotMove { id, x, y } => {
            edit_annotations(move |list| {
                move_annotation(list, &id, x, y, now()).map(|next| (next, json!({ "ok": true })))
            })
            .await?
        }
        Message::VideoNotesTake {
            id,
            title,
            kind,
            parts,
            add,
        } => video_notes::take(id, title, kind, parts, add).await,
        Message::VideoNotesCancel { id } => video_notes::cancel(id).await,
        Message::AnnotDelete { id } => {
            edit_annotations(move |list| Ok((delete_annotation(list, &id), json!({ "ok": true }))))
                .await?
        }
    })
}
