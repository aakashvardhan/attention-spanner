//! The browser's own surfaces, outside the extension's pages: the toolbar
//! badge, keyboard commands, the omnibox keyword and the context menus.

use super::session;
use crate::chrome;
use crate::js::{from_js, now, to_js, today_start, wait, Res};
use crate::store;
use reader_core::constants::{NEWTAB_PAGE_PATH, PAPERS_PAGE_PATH};
use reader_core::papers::{search_papers, xml_escape};
use reader_core::pdf::{paper_open_url, paper_pdf_source, reader_page_path};
use reader_core::pomodoro::{open_tasks, start_todos, Phase, Pomodoro, MAX_TASKS};
use reader_core::todos::{keep_today, Todo};
use reader_core::types::{FocusSession, Paper};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

/// Fires when the badge's minute count drops.
pub const BADGE_ALARM: &str = "badge";

/// The toolbar icon says what is running: minutes left in a round, a dot
/// while a reader tab is open, nothing otherwise.
pub async fn refresh_badge() -> Res<()> {
    let round: Option<Pomodoro> = store::get("pomodoro").await?;
    let session: Option<FocusSession> = store::get("focusSession").await?;
    wait(chrome::alarms_clear(BADGE_ALARM)).await?;
    let left = round.as_ref().map(|p| (p.ends_at - now()).max(0));
    let (text, color) = match (&round, left) {
        (Some(p), Some(left)) => {
            let minutes = (left + 59_999) / 60_000;
            // One alarm, at the moment the count changes; the round's own alarm ends it.
            if minutes > 1 {
                let when = p.ends_at - (minutes - 1) * 60_000;
                wait(chrome::alarms_create(
                    BADGE_ALARM,
                    &to_js(&json!({ "when": when }))?,
                ))
                .await?;
            }
            let color = if p.phase == Phase::Focus {
                "#c62828"
            } else {
                "#1e5326"
            };
            (format!("{minutes}m"), color)
        }
        _ if session.is_some() => ("\u{2022}".to_string(), "#c62828"),
        _ => (String::new(), "#c62828"),
    };
    wait(chrome::action_set_badge_text(&to_js(
        &json!({ "text": text }),
    )?))
    .await?;
    wait(chrome::action_set_badge_background_color(&to_js(
        &json!({ "color": color }),
    )?))
    .await?;
    wait(chrome::action_set_badge_text_color(&to_js(
        &json!({ "color": "#ffffff" }),
    )?))
    .await
    .map(drop)
}

async fn open_tab(url: &str) -> Res<()> {
    wait(chrome::tabs_create(&to_js(&json!({ "url": url }))?))
        .await
        .map(drop)
}

/// A keyboard command from the manifest (`_execute_action` never reaches here:
/// Chrome turns it into a click on the icon).
pub async fn command(name: &str) -> Res<()> {
    match name {
        "back-to-paper" => {
            if session::focus_reader().await? {
                return Ok(());
            }
            // No reader open: the paper read last, where it was left.
            let papers: Vec<Paper> = store::get("papers").await?;
            let url = search_papers(&papers, "", 1)
                .first()
                .filter(|p| p.last_read_at.is_some())
                .map(|p| paper_open_url(p, false, &chrome::get_url("")))
                .unwrap_or_else(|| chrome::get_url(PAPERS_PAGE_PATH));
            open_tab(&url).await
        }
        "focus-round" => {
            // The board's top open tasks, as the new tab's "Start a focus round" preselects them.
            let started = store::with_lock("tasks", async {
                if store::get::<Option<Pomodoro>>("pomodoro").await?.is_some() {
                    return Res::Ok(None);
                }
                let mut list: Vec<Todo> = store::get("todos").await?;
                let ids: Vec<String> = open_tasks(&list)
                    .iter()
                    .take(MAX_TASKS)
                    .map(|t| t.id.clone())
                    .collect();
                let Some(round) = start_todos(&mut list, &ids, now()) else {
                    return Ok(None);
                };
                // Written as the new tab writes the board: yesterday's finished tasks go.
                let items = json!({ "todos": keep_today(list, today_start()), "pomodoro": round });
                store::set_many(items.as_object().expect("object")).await?;
                Ok(Some(round))
            })
            .await?;
            match started {
                Some(round) => {
                    let tasks: Vec<String> = round.tasks.into_iter().map(|t| t.text).collect();
                    wait(chrome::notifications_create(
                        "focus-round",
                        &to_js(&json!({
                            "type": "basic",
                            "iconUrl": chrome::get_url("icons/icon-128.png"),
                            "title": "Focus: 25 minutes",
                            "message": tasks.join("\n"),
                            "silent": true,
                        }))?,
                    ))
                    .await
                    .map(drop)
                }
                // Already running, or nothing to focus on: the new tab shows which.
                None => open_tab(&chrome::get_url(NEWTAB_PAGE_PATH)).await,
            }
        }
        _ => Ok(()),
    }
}

/// `r <words>` in the address bar: the shelf's matching papers.
pub async fn omnibox_suggest(text: &str) -> Res<JsValue> {
    let papers: Vec<Paper> = store::get("papers").await?;
    let base = chrome::get_url("");
    let rows: Vec<Value> = search_papers(&papers, text, 6)
        .into_iter()
        .map(|p| {
            let read = p.progress_percent.round() as i64;
            json!({
                "content": paper_open_url(p, false, &base),
                "description": format!("{} <dim>{read}% read</dim>", xml_escape(&p.title)),
            })
        })
        .collect();
    to_js(&rows)
}

/// Where Enter goes: a picked suggestion is already a URL; typed words open
/// the best match, or the papers page when nothing matches.
pub async fn omnibox_url(text: &str) -> Res<String> {
    let base = chrome::get_url("");
    if text.starts_with(&base) || text.starts_with("https://") {
        return Ok(text.to_string());
    }
    let papers: Vec<Paper> = store::get("papers").await?;
    Ok(search_papers(&papers, text, 1)
        .first()
        .filter(|_| !text.trim().is_empty())
        .map(|p| paper_open_url(p, false, &base))
        .unwrap_or_else(|| chrome::get_url(PAPERS_PAGE_PATH)))
}

const MENU_READER: &str = "open-reader";
/// Paper links on arXiv and alphaXiv, with or without www (`*.` covers the
/// bare domain): the abs, pdf and overview pages paper_pdf_source turns into
/// a PDF, not every link on those sites, where the item would do nothing.
const MENU_READER_LINKS: [&str; 5] = [
    "*://*.arxiv.org/abs/*",
    "*://*.arxiv.org/pdf/*",
    "*://*.alphaxiv.org/abs/*",
    "*://*.alphaxiv.org/pdf/*",
    "*://*.alphaxiv.org/overview/*",
];
const MENU_LEXICON: &str = "lexicon";
/// Handled in worker.js: opening the side panel must happen inside the click.
const MENU_PANEL: &str = "panel";

/// Menus persist across worker restarts; rebuilt on install and update.
pub async fn create_menus() -> Res<()> {
    wait(chrome::context_menus_remove_all()).await?;
    for item in [
        json!({
            "id": MENU_READER, "title": "Open in Reader", "contexts": ["link"],
            "targetUrlPatterns": MENU_READER_LINKS,
        }),
        json!({ "id": MENU_LEXICON, "title": "Add \u{201c}%s\u{201d} to the lexicon", "contexts": ["selection"] }),
        json!({ "id": MENU_PANEL, "title": "Listen or talk this page through", "contexts": ["page"] }),
    ] {
        chrome::context_menus_create(&to_js(&item)?)?;
    }
    Ok(())
}

pub async fn menu_clicked(info: JsValue, tab: JsValue) -> Res<()> {
    let info: Value = from_js(info)?;
    let tab: Value = from_js(tab).unwrap_or_default();
    match info["menuItemId"].as_str() {
        Some(MENU_READER) => {
            let link = info["linkUrl"].as_str().unwrap_or_default();
            match paper_pdf_source(link, None) {
                Some(pdf) => open_tab(&chrome::get_url(&reader_page_path(&pdf))).await,
                None => Ok(()),
            }
        }
        Some(MENU_LEXICON) => {
            let label = info["selectionText"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            let page = info["pageUrl"].as_str().unwrap_or_default();
            // No definition yet: the term is kept with where it was met, to be defined in a reader.
            let source = reader_core::lexicon::Source {
                doc_key: reader_core::annotations::annotation_doc_key(page),
                paper_title: tab["title"].as_str().unwrap_or(page).to_string(),
                definition: String::new(),
                guess: String::new(),
                context: String::new(),
                added_at: now(),
            };
            crate::pages::lexicon::keep_term(label, source).await;
            Ok(())
        }
        _ => Ok(()),
    }
}
