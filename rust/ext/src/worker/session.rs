//! The reading session: while a
//! reader tab is open, the blocklist redirects to the blocked page. Storage
//! (`focusSession`) is the truth; DNR session rules are rebuilt from it.

use crate::chrome;
use crate::js::{from_js, local_date, now, to_js, wait, Res};
use crate::store;
use reader_core::activity::{add_activity, ActivityEvent, ActivityLog};
use reader_core::constants::{
    BLOCKED_PAGE_PATH, DAILY_GATE_DNR_ID, FOCUS_DNR_ID_BASE, FOCUS_DNR_ID_LIMIT, READER_PAGE_PATH,
};
use reader_core::focus_rules::{
    build_focus_rules, build_session_access_rules, is_blocked_host, is_owned_session_rule,
    study_video_rule, with_reader_tab, without_reader_tab,
};
use reader_core::pomodoro::{advance, focus_blocklist, is_focus, Phase, Pomodoro, POMODORO_ALARM};
use reader_core::types::FocusSession;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Rule {
    id: i64,
}

#[derive(Deserialize)]
struct Tab {
    id: Option<i32>,
    url: Option<String>,
    #[serde(rename = "windowId")]
    window_id: Option<i32>,
}

fn blocked_page_url() -> String {
    chrome::get_url(BLOCKED_PAGE_PATH)
}

pub fn is_reader_url(url: &str) -> bool {
    url.starts_with(&chrome::get_url(READER_PAGE_PATH))
}

/// Fold one event into the heatmap log; the worker is its only writer.
pub async fn log_activity(event: ActivityEvent) -> Res<()> {
    let log: ActivityLog = store::get("activity").await?;
    if let Some(next) = add_activity(&log, &event, local_date(now())) {
        store::set("activity", &next).await?;
    }
    Ok(())
}

/// Rebuild the session rules in one atomic update; one retry, since startup,
/// install and a page message can reconcile at the same moment.
pub async fn sync_session_access_rules() -> Res<()> {
    let mut last = Ok(());
    for _ in 0..2 {
        let session: Option<FocusSession> = store::get("focusSession").await?;
        let settings = store::settings().await?;
        let existing: Vec<Rule> = from_js(wait(chrome::dnr_get_session_rules()).await?)?;
        let remove: Vec<i64> = existing
            .iter()
            .map(|r| r.id)
            .filter(|id| is_owned_session_rule(*id))
            .collect();
        let pomodoro: Option<Pomodoro> = store::get("pomodoro").await?;
        let mut add = if is_focus(pomodoro.as_ref()) {
            build_focus_rules(
                &focus_blocklist(&settings.focus_blocklist),
                &blocked_page_url(),
            )
        } else {
            build_session_access_rules(
                session.as_ref(),
                &settings.focus_blocklist,
                &blocked_page_url(),
            )
        };
        if let Some(rule) = pomodoro
            .as_ref()
            .filter(|p| is_focus(Some(p)))
            .and_then(|p| p.study_video.as_deref())
            .and_then(study_video_rule)
        {
            add.push(rule);
        }
        last = wait(chrome::dnr_update_session_rules(&to_js(
            &json!({ "removeRuleIds": remove, "addRules": add }),
        )?))
        .await
        .map(drop);
        if last.is_ok() {
            break;
        }
    }
    // Every change to the session or the round passes through here, so the
    // badge follows from one place. It is decoration: never fail the rules for it.
    if let Err(e) = super::browser::refresh_badge().await {
        crate::js::log_error("[worker] badge", &e);
    }
    last
}

/// The retired daily gate's dynamic rules survive updates; sweep them on every start.
pub async fn remove_legacy_daily_gate_rule() -> Res<()> {
    let rules: Vec<Rule> = from_js(wait(chrome::dnr_get_dynamic_rules()).await?)?;
    let remove: Vec<i64> = rules
        .iter()
        .map(|r| r.id)
        .filter(|&id| {
            id == DAILY_GATE_DNR_ID || (FOCUS_DNR_ID_BASE..FOCUS_DNR_ID_LIMIT).contains(&id)
        })
        .collect();
    if !remove.is_empty() {
        wait(chrome::dnr_update_dynamic_rules(&to_js(
            &json!({ "removeRuleIds": remove }),
        )?))
        .await?;
    }
    Ok(())
}

/// An already-open blocked tab would defeat the point. `round` is the
/// Pomodoro the caller has just read (its study video stays open).
pub async fn redirect_open_blocked_tabs(round: Option<&Pomodoro>, domains: &[String]) -> Res<()> {
    let tabs: Vec<Tab> = from_js(
        wait(chrome::tabs_query(&to_js(
            &json!({ "url": ["http://*/*", "https://*/*"] }),
        )?))
        .await?,
    )?;
    for tab in tabs {
        if let (Some(id), Some(url)) = (tab.id, tab.url) {
            redirect_if_blocked(id, &url, round, domains).await?;
        }
    }
    Ok(())
}

/// The one block decision: a blocked http(s) host, unless it is the round's study video.
async fn redirect_if_blocked(
    tab_id: i32,
    url: &str,
    round: Option<&Pomodoro>,
    domains: &[String],
) -> Res<()> {
    if allows_study_video(round, url) {
        return Ok(());
    }
    let Ok(parsed) = url::Url::parse(url) else {
        return Ok(());
    };
    if matches!(parsed.scheme(), "http" | "https")
        && is_blocked_host(parsed.host_str().unwrap_or(""), domains)
    {
        let target = format!("{}#{url}", blocked_page_url());
        wait(chrome::tabs_update(
            tab_id,
            &to_js(&json!({ "url": target }))?,
        ))
        .await?;
    }
    Ok(())
}

fn allows_study_video(round: Option<&Pomodoro>, url: &str) -> bool {
    round
        .filter(|p| is_focus(Some(p)))
        .and_then(|p| p.study_video.as_ref())
        .is_some_and(|id| reader_core::youtube::video_id(url).as_ref() == Some(id))
}

/// YouTube also navigates without a document request, so check its URL changes.
pub async fn check_focus_navigation(tab_id: i32, url: &str) -> Res<()> {
    // Only web pages are ever blocked: skip the storage reads for the rest.
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Ok(());
    }
    let round: Option<Pomodoro> = store::get("pomodoro").await?;
    if !is_focus(round.as_ref()) {
        return Ok(());
    }
    let domains = focus_blocklist(&store::settings().await?.focus_blocklist);
    redirect_if_blocked(tab_id, url, round.as_ref(), &domains).await
}

/// A reader page announced itself; the first one starts the session.
pub async fn reader_opened(tab_id: i32, title: &str) -> Res<()> {
    let session: Option<FocusSession> = store::get("focusSession").await?;
    let starting = session.is_none();
    store::set(
        "focusSession",
        &with_reader_tab(session, tab_id, title, now()),
    )
    .await?;
    sync_session_access_rules().await?;
    if starting {
        let round: Option<Pomodoro> = store::get("pomodoro").await?;
        redirect_open_blocked_tabs(round.as_ref(), &store::settings().await?.focus_blocklist)
            .await?;
    }
    Ok(())
}

/// A reader tab closed or left; the last one ends the session.
pub async fn reader_closed(tab_id: i32) -> Res<()> {
    let session: Option<FocusSession> = store::get("focusSession").await?;
    let Some(current) = session.filter(|s| s.tab_ids.contains(&tab_id)) else {
        return Ok(());
    };
    let started = current.started_at;
    let next = without_reader_tab(Some(current), tab_id);
    store::set("focusSession", &next).await?;
    if next.is_none() {
        // A finished session is the heatmap's "focus" square, and its minutes.
        log_activity(ActivityEvent::Focus).await?;
        log_activity(ActivityEvent::Clocked(
            ((now() - started) / 60_000).max(0) as u32
        ))
        .await?;
    }
    sync_session_access_rules().await
}

/// "Back to your paper": bring the last reader tab forward.
pub async fn focus_reader() -> Res<bool> {
    let session: Option<FocusSession> = store::get("focusSession").await?;
    let Some(tab_id) = session.and_then(|s| s.tab_ids.last().copied()) else {
        return Ok(false);
    };
    let Ok(tab) = wait(chrome::tabs_update(
        tab_id,
        &to_js(&json!({ "active": true }))?,
    ))
    .await
    else {
        return Ok(false);
    };
    if let Some(window) = from_js::<Tab>(tab).ok().and_then(|t| t.window_id) {
        wait(chrome::windows_update(
            window,
            &to_js(&json!({ "focused": true }))?,
        ))
        .await?;
    }
    Ok(true)
}

#[derive(Deserialize)]
struct Context {
    #[serde(rename = "tabId")]
    tab_id: i32,
    #[serde(rename = "documentUrl")]
    document_url: Option<String>,
}

/// Drop every id that is no longer an open reader tab. Runs on startup (tab
/// ids do not survive a restart), on every worker start, and whenever the
/// blocked page shows: a reader close the worker never heard (extension
/// reload, worker killed) must not block sites until the browser restarts.
/// Asks getContexts, not tabs.get: without the "tabs" permission Chromium
/// hides every tab's url, our own pages included. Rules never outlive state.
pub async fn reconcile_session() -> Res<()> {
    let session: Option<FocusSession> = store::get("focusSession").await?;
    let open: Vec<Context> = from_js(
        wait(chrome::runtime_get_contexts(&to_js(
            &json!({ "contextTypes": ["TAB"] }),
        )?))
        .await?,
    )?;
    let mut next = session.clone();
    for id in session.iter().flat_map(|s| s.tab_ids.clone()) {
        let alive = open
            .iter()
            .any(|c| c.tab_id == id && c.document_url.as_deref().is_some_and(is_reader_url));
        if !alive {
            next = without_reader_tab(next, id);
        }
    }
    if next != session {
        store::set("focusSession", &next).await?;
    }
    sync_session_access_rules().await
}

/// The blocklist was edited mid-session.
pub async fn refresh_focus_rules(blocklist: &[String]) -> Res<()> {
    let session: Option<FocusSession> = store::get("focusSession").await?;
    let pomodoro: Option<Pomodoro> = store::get("pomodoro").await?;
    if is_focus(pomodoro.as_ref()) {
        sync_session_access_rules().await?;
        redirect_open_blocked_tabs(pomodoro.as_ref(), &focus_blocklist(blocklist)).await?;
    } else if session.is_some() {
        sync_session_access_rules().await?;
        redirect_open_blocked_tabs(pomodoro.as_ref(), blocklist).await?;
    }
    Ok(())
}

/// The Pomodoro changed (started, ticked, advanced, stopped): one alarm at
/// the phase end, and the blocklist on exactly while focusing.
pub async fn pomodoro_changed() -> Res<()> {
    let p: Option<Pomodoro> = store::get("pomodoro").await?;
    wait(chrome::alarms_clear(POMODORO_ALARM)).await?;
    if let Some(p) = &p {
        wait(chrome::alarms_create(
            POMODORO_ALARM,
            &to_js(&json!({ "when": p.ends_at }))?,
        ))
        .await?;
    }
    sync_session_access_rules().await?;
    if is_focus(p.as_ref()) {
        redirect_open_blocked_tabs(
            p.as_ref(),
            &focus_blocklist(&store::settings().await?.focus_blocklist),
        )
        .await?;
    }
    Ok(())
}

/// The phase is up: move on, ring, and say what comes next.
pub async fn pomodoro_alarm() -> Res<()> {
    // Only the state change holds the tasks lock; the bell and the notice run after.
    let into_break = store::with_lock("tasks", async {
        let Some(p) = store::get::<Option<Pomodoro>>("pomodoro").await? else {
            return Ok(None);
        };
        // A stale alarm (the phase was restarted meanwhile) waits for its own.
        if now() + 1000 < p.ends_at {
            return Ok(None);
        }
        let into_break = p.phase == Phase::Focus;
        if into_break {
            log_activity(ActivityEvent::Focus).await?;
            log_activity(ActivityEvent::Clocked(
                ((p.ends_at - p.started_at) / 60_000) as u32,
            ))
            .await?;
        }
        store::set("pomodoro", &advance(p, now())).await?;
        Res::Ok(Some(into_break))
    })
    .await?;
    let Some(into_break) = into_break else {
        return Ok(());
    };
    {
        let kind = if into_break { "break" } else { "focus" };
        let _ = wait(chrome::offscreen_close()).await; // the last chime may still be open
        let _ = wait(chrome::offscreen_create(&to_js(&json!({
            "url": format!("chime.html#{kind}"),
            "reasons": ["AUDIO_PLAYBACK"],
            "justification": "The Pomodoro bell at the end of a focus round or a break.",
        }))?))
        .await;
        let (title, message) = if into_break {
            (
                "Break",
                "Five minutes. Step away and breathe; the sites are open again.",
            )
        } else {
            (
                "Break over",
                "Pick up to three tasks from your board on the new tab when you are ready for the next round.",
            )
        };
        wait(chrome::notifications_create(
            POMODORO_ALARM,
            &to_js(&json!({
                "type": "basic",
                "iconUrl": chrome::get_url("icons/icon-128.png"),
                "title": title,
                "message": message,
                "silent": true,
            }))?,
        ))
        .await
        .map(drop)
    }
}
