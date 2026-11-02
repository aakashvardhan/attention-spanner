//! Schema migrations (src/shared/storage.ts `migrate`), as one pure function:
//! a snapshot of chrome.storage.local in, a plan (keys to set, keys to remove)
//! out. The worker applies the plan; the order of steps is the TS order.

use crate::alphaxiv::PushItem;
use crate::papers::arxiv_id;
use crate::types::Paper;
use serde_json::{json, Map, Value};

pub const SCHEMA_VERSION: u32 = 28;

/// Local keys of cut features. Cumulative: every bump re-runs the sweep, and
/// removing an absent key is a no-op. Never list a live key (a test checks).
pub const DEAD_KEYS: &[&str] = &[
    "notes",
    "notesVault",
    "notionQueue",
    "notionStatus",
    "meetingNotes",
    "dailyBrainDumpGate",
    "tasks",
    "jobs",
    "jobSources",
    "jobProfile",
    "jobRuns",
    "assistantMemory",
    "assistantSkills",
    "assistantAutomations",
    "assistantJournal",
    "assistantProfile",
    "assistantBriefing",
    "weekReviews",
    "pdfOutlineCache",
    "recordings",
    "calendar",
    "gmail",
    "streaks",
    "gamification",
    "gym",
    "warmup",
    "siteTime",
    "activeIntent",
    "enabledPacks",
    "parkingLot",
    "docCitations",
    "graphCitations",
    "graphNodes",
    "graphView",
    "graphVisible",
    "sync",
    "tombstones",
    "flashCards",
    "flashNotes",
    "srsDaily",
    "alphaxiv",
    "xBookmarks",
    "xBookmarksLastSyncedAt",
    "focusOfDay",
    "weather",
    "bookmarks",
    "bookmarkGroups",
    "aiStats",
    "feeds",
    "readItems",
    "cachedItems",
    "cacheTimestamp",
    "readingProgress",
    "aiVectors",
    "layaRoles",
    "provocations",
    "decks",
];

/// Settings of cut features, stripped from the stored settings object.
pub const DEAD_SETTINGS: &[&str] = &[
    "assistantEnabled",
    "geminiApiKey",
    "anthropicApiKey",
    "cloudProvider",
    "assistantReactEnabled",
    "assistantVoiceEnabled",
    "assistantTtsVoice",
    "assistantVisionEnabled",
    "assistantLiveEnabled",
    "assistantMonitorEnabled",
    "assistantWakeWordEnabled",
    "monitorEveningTime",
    "ollamaBaseUrl",
    "ollamaModel",
    "taskReminderIntervalMinutes",
    "sprintMinutes",
    "dailyGoalMinutes",
    "gmailTriageTime",
    "focusCalendarBlockEnabled",
    "timePillHosts",
    "hyperfocusEnabled",
    "focusMusicEnabled",
    "geminiKey",
    "nudgesEnabled",
    "dashboardMode",
    "dashColumns",
    "dashCardOrder",
    "dashHiddenCards",
    "dashFullWidthCards",
    "gymWeeklyTarget",
    "gymReminderTime",
    "notesPasscodeHash",
    "questArticlesPerWeek",
    "questSprintsPerWeek",
    "questVideosPerWeek",
    "questFocusPerWeek",
    "focusBreakMinutes",
    "displayName",
    "weatherLocation",
    "ambientMotion",
    "refreshInterval",
    "focusMinutes",
    "breakMinutes",
    "focusSound",
    "semanticScholarApiKey",
    "ollamaUrl",
    "ollamaChatModel",
    "ollamaEmbedModel",
    "cloudMode",
    "layaUrl",
    "mutedTopics",
    "trackTopics",
    "geminiTopicKey",
    "notificationsEnabled",
    "theme",
    "readerNight",
];

/// Session keys cleared on every install/update (session storage outlives an update).
pub const DEAD_SESSION_KEYS: &[&str] = &["hyperfocus", "driftChecked", "lastGlobalNudgeAt"];
/// Session keys of the features cut in v27.
pub const V27_DEAD_SESSION_KEYS: &[&str] = &[
    "trackedTabs",
    "pendingResume",
    "videoTranscripts",
    "topicVerdicts",
];

/// What to write back: the worker removes `remove`, then sets `set`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Plan {
    pub set: Map<String, Value>,
    pub remove: Vec<String>,
    pub session_remove: Vec<String>,
}

/// v6 → v7: `pdfAnnotations` become `annotations` with an `anchor` union.
pub fn v7_annotations(legacy: Option<&Value>) -> Option<Vec<Value>> {
    let list = legacy?.as_array().filter(|l| !l.is_empty())?;
    Some(
        list.iter()
            .map(|a| {
                let mut rest = a.as_object().cloned().unwrap_or_default();
                let take =
                    |rest: &mut Map<String, Value>, k: &str| rest.remove(k).unwrap_or(Value::Null);
                let (page, rects, x, y, url) = (
                    take(&mut rest, "page"),
                    take(&mut rest, "rects"),
                    take(&mut rest, "x"),
                    take(&mut rest, "y"),
                    take(&mut rest, "pdfUrl"),
                );
                rest.insert("docUrl".into(), url);
                rest.insert(
                    "anchor".into(),
                    json!({ "kind": "pdf", "page": page, "rects": rects, "x": x, "y": y }),
                );
                Value::Object(rest)
            })
            .collect(),
    )
}

/// The dead settings stripped; `None` when the stored value is not an object.
pub fn strip_settings(settings: Option<&Value>) -> Option<Value> {
    let mut next = settings?.as_object()?.clone();
    for key in DEAD_SETTINGS {
        next.remove(*key);
    }
    Some(Value::Object(next))
}

/// v23 → v24: roots only, task fields gone. `new_id` makes ids for records with none.
pub fn v24_dumps(list: &[Value], mut new_id: impl FnMut() -> String) -> Vec<Value> {
    list.iter()
        .filter(|d| d.get("parentId").is_none_or(Value::is_null) && d.get("text").is_some_and(Value::is_string))
        .map(|d| {
            let id = match d.get("id") {
                Some(Value::String(s)) if !s.is_empty() => s.clone(),
                Some(Value::Number(n)) => n.to_string(),
                _ => new_id(),
            };
            json!({ "id": id, "text": d["text"], "createdAt": d.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0) as i64 })
        })
        .collect()
}

/// v26 → v27: arXiv papers re-keyed by id, queued for alphaXiv under their
/// old deck's name; everything else dropped. Re-running keeps folder ids.
pub fn v27_papers(papers: &[Value], decks: &[Value], now: i64) -> (Vec<Paper>, Vec<PushItem>) {
    let deck_name = |id: &str| {
        decks
            .iter()
            .find(|d| d.get("id").and_then(Value::as_str) == Some(id))
            .and_then(|d| d.get("name")?.as_str())
    };
    let str_of = |p: &Value, k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let num_of = |p: &Value, k: &str| p.get(k).and_then(Value::as_f64);
    let mut out: Vec<Paper> = Vec::new();
    let mut push = Vec::new();
    for p in papers.iter().filter(|p| p.is_object()) {
        let pdf: Option<crate::types::PdfState> = p
            .get("pdf")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok());
        // Either link may be the arXiv one (a project page with an arXiv PDF, say).
        let Some(id) =
            arxiv_id(&str_of(p, "url")).or_else(|| pdf.as_ref().and_then(|d| arxiv_id(&d.url)))
        else {
            continue;
        };
        if out.iter().any(|o| o.id == id) {
            continue;
        }
        let updated = num_of(p, "updatedAt").map_or(now, |n| n as i64);
        let title = str_of(p, "title");
        out.push(Paper {
            title: if title.is_empty() { id.clone() } else { title },
            authors: str_of(p, "authors"),
            year: num_of(p, "year").map(|y| y as i32),
            url: format!("https://arxiv.org/abs/{id}"),
            folder_ids: p
                .get("folderIds")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_default(),
            progress_percent: num_of(p, "progressPercent").unwrap_or(0.0),
            left_off: str_of(p, "leftOff"),
            pdf: pdf.filter(|d| !d.url.is_empty()),
            added_at: num_of(p, "addedAt").map_or(updated, |n| n as i64),
            updated_at: updated,
            last_read_at: num_of(p, "lastReadAt").map(|n| n as i64),
            deleted_at: None,
            id: id.clone(),
        });
        push.push(PushItem {
            id,
            folder: deck_name(&str_of(p, "deckId"))
                .unwrap_or("Want to read")
                .to_string(),
        });
    }
    (out, push)
}

/// v27: annotations live on only for arXiv documents.
pub fn v27_annotations(list: &[Value]) -> Vec<Value> {
    list.iter()
        .filter(|a| {
            a.get("docKey")
                .and_then(Value::as_str)
                .is_some_and(|k| k.starts_with("arxiv:"))
        })
        .cloned()
        .collect()
}

/// v27: a Pomodoro-shaped session cannot block anything; only a reader session survives.
pub fn v27_focus_session(session: Option<&Value>) -> Value {
    match session {
        Some(s)
            if s.get("tabIds").is_some_and(Value::is_array)
                && s.get("startedAt").is_some_and(Value::is_number) =>
        {
            s.clone()
        }
        _ => Value::Null,
    }
}

/// The whole migration: `local` is `chrome.storage.local.get(null)`.
pub fn migrate(local: &Map<String, Value>, now: i64, new_id: impl FnMut() -> String) -> Plan {
    let mut plan = Plan {
        session_remove: DEAD_SESSION_KEYS.iter().map(|s| s.to_string()).collect(),
        ..Plan::default()
    };
    let version = local
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    if version >= SCHEMA_VERSION {
        return plan;
    }
    // A working copy, so each step reads what the previous one wrote, as the TS did.
    let mut db = local.clone();
    let arr = |db: &Map<String, Value>, k: &str| {
        db.get(k)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };

    if version < 7 {
        if let Some(converted) = v7_annotations(db.get("pdfAnnotations")) {
            db.insert("annotations".into(), Value::Array(converted));
        }
        db.remove("pdfAnnotations");
        plan.remove.push("pdfAnnotations".into());
    }
    if version < 27 {
        // Reads the old decks, so it runs before the sweep removes them.
        let (papers, push) = v27_papers(&arr(&db, "papers"), &arr(&db, "decks"), now);
        db.insert(
            "papers".into(),
            serde_json::to_value(papers).unwrap_or_default(),
        );
        // Written once: a re-run must not rewrite a queue the sync is draining.
        if !db.get("alphaxivPush").is_some_and(Value::is_array) {
            db.insert(
                "alphaxivPush".into(),
                serde_json::to_value(push).unwrap_or_default(),
            );
        }
        db.insert(
            "annotations".into(),
            Value::Array(v27_annotations(&arr(&db, "annotations"))),
        );
        db.insert(
            "focusSession".into(),
            v27_focus_session(db.get("focusSession")),
        );
        plan.session_remove
            .extend(V27_DEAD_SESSION_KEYS.iter().map(|s| s.to_string()));
    }
    for key in DEAD_KEYS {
        db.remove(*key);
    }
    plan.remove.extend(DEAD_KEYS.iter().map(|s| s.to_string()));
    if let Some(settings) = strip_settings(db.get("settings")) {
        db.insert("settings".into(), settings);
    }
    if version < 24 {
        let dumps = v24_dumps(&arr(&db, "dumps"), new_id);
        db.insert("dumps".into(), Value::Array(dumps));
    }
    db.insert("schemaVersion".into(), json!(SCHEMA_VERSION));

    // The plan: every key that differs from what was stored.
    plan.set = db
        .into_iter()
        .filter(|(k, v)| local.get(k) != Some(v))
        .collect();
    plan.remove.retain(|k| local.contains_key(k));
    plan
}

#[cfg(test)]
mod tests;
