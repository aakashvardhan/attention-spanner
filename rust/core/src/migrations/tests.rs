use super::*;
use serde_json::json;

const NOW: i64 = 1_800_000_000_000;
/// Every local key the extension still reads (the TS DEFAULTS).
const LIVE_KEYS: &[&str] = &[
    "schemaVersion",
    "settings",
    "focusSession",
    "folders",
    "papers",
    "alphaxivPush",
    "alphaxivAuth",
    "alphaxivClient",
    "alphaxivStatus",
    "annotations",
    "aiCache",
    "activity",
    "dumps",
    "vault",
    "lockedDumps",
    "explainBacks",
    "lexicon",
    "pomodoro",
    "todos",
    "videoNotes",
    "videoNotesJobs",
    "hnFeed",
    "weatherNow",
];
/// Every setting the extension reads: the fields of `Settings`, as stored.
fn live_settings() -> Vec<String> {
    serde_json::to_value(crate::types::Settings::default())
        .unwrap()
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect()
}

fn obj(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}
/// Apply a plan the way the worker will: remove, then set.
fn apply(local: &Map<String, Value>, plan: &Plan) -> Map<String, Value> {
    let mut next = local.clone();
    for k in &plan.remove {
        next.remove(k);
    }
    next.extend(plan.set.clone());
    next
}
fn no_ids() -> impl FnMut() -> String {
    || panic!("no id should be needed")
}

#[test]
fn v7_wraps_pdf_annotations_into_the_anchor_union() {
    let legacy = json!([{
        "id": "a", "docKey": "k", "pdfUrl": "https://arxiv.org/pdf/1", "paperId": "p1", "kind": "highlight",
        "page": 4, "rects": [{ "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.04 }], "x": 0, "y": 0,
        "text": "quoted", "color": "yellow", "note": "", "createdAt": 1, "updatedAt": 2
    }]);
    assert_eq!(
        v7_annotations(Some(&legacy)),
        Some(vec![json!({
            "id": "a", "docKey": "k", "docUrl": "https://arxiv.org/pdf/1", "paperId": "p1", "kind": "highlight",
            "anchor": { "kind": "pdf", "page": 4, "rects": [{ "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.04 }], "x": 0, "y": 0 },
            "text": "quoted", "color": "yellow", "note": "", "createdAt": 1, "updatedAt": 2
        })])
    );
    assert_eq!(v7_annotations(Some(&json!([]))), None);
    assert_eq!(v7_annotations(None), None);
}

#[test]
fn dead_lists_name_only_cut_features() {
    for dead in [
        "tasks",
        "notes",
        "jobs",
        "recordings",
        "gmail",
        "calendar",
        "streaks",
        "bookmarks",
        "bookmarkGroups",
        "notionQueue",
        "flashCards",
        "focusOfDay",
        "weather",
        "aiStats",
    ] {
        assert!(DEAD_KEYS.contains(&dead), "{dead}");
    }
    for live in LIVE_KEYS {
        assert!(!DEAD_KEYS.contains(live), "{live} would be deleted");
    }
    for live in live_settings() {
        assert!(
            !DEAD_SETTINGS.contains(&live.as_str()),
            "{live} would be deleted"
        );
    }
}

#[test]
fn strip_settings_drops_every_retired_setting_and_nothing_else() {
    let cases = [
        (
            json!({ "claudeKey": "k", "geminiApiKey": "s", "assistantEnabled": true, "taskReminderIntervalMinutes": 60, "timePillHosts": ["y"], "gmailTriageTime": "08:30" }),
            json!({ "claudeKey": "k" }),
        ),
        (
            json!({ "claudeKey": "k", "focusBreakMinutes": 10 }),
            json!({ "claudeKey": "k" }),
        ),
        (
            json!({ "displayName": "A", "weatherLocation": "X", "ambientMotion": true, "claudeKey": "k" }),
            json!({ "claudeKey": "k" }),
        ),
        (
            json!({ "hyperfocusEnabled": true, "focusMusicEnabled": true, "geminiKey": "k", "nudgesEnabled": true, "claudeKey": "k" }),
            json!({ "claudeKey": "k" }),
        ),
        (
            json!({ "claudeKey": "k", "geminiTopicKey": "k", "ollamaUrl": "u", "cloudMode": "all", "focusMinutes": 50, "mutedTopics": [] }),
            json!({ "claudeKey": "k" }),
        ),
        (
            json!({ "theme": "paperwhite", "readerNight": true, "claudeKey": "k" }),
            json!({ "claudeKey": "k" }),
        ),
        (json!({}), json!({})),
    ];
    for (input, want) in cases {
        assert_eq!(strip_settings(Some(&input), 26), Some(want));
    }
    assert_eq!(strip_settings(None, 26), None);
    assert_eq!(strip_settings(Some(&json!("string")), 26), None);
    // From v28 on these names are the palette and the Gemini key: kept.
    let live = json!({ "theme": "grid", "geminiKey": "g", "claudeKey": "k" });
    assert_eq!(strip_settings(Some(&live), SCHEMA_VERSION), Some(live));
}

#[test]
fn v24_keeps_roots_only_and_mints_an_id_when_missing() {
    let dumps = [
        json!({ "id": "r", "text": "raw", "createdAt": 1, "nextStep": "s", "kind": "task" }),
        json!({ "id": "p", "text": "point", "createdAt": 2, "parentId": "r" }),
    ];
    assert_eq!(
        v24_dumps(&dumps, no_ids()),
        [json!({ "id": "r", "text": "raw", "createdAt": 1 })]
    );
    let out = v24_dumps(&[json!({ "text": "no id or date" })], || "minted".into());
    assert_eq!(
        out,
        [json!({ "id": "minted", "text": "no id or date", "createdAt": 0 })]
    );
}

fn old_paper(over: Value) -> Value {
    let mut p = json!({
        "id": "x", "deckId": "d1", "title": "T", "authors": "A", "venue": "V", "year": 2020, "citations": 3, "abstract": "ab",
        "relevance": "r", "status": "reading", "pass": 2, "progressPercent": 40, "leftOff": "§3", "addedAt": 1, "updatedAt": 2,
        "lastReadAt": 3, "url": "https://arxiv.org/abs/2006.11239v2"
    });
    p.as_object_mut().unwrap().extend(obj(over));
    p
}
fn decks() -> Vec<Value> {
    vec![
        json!({ "id": "d1", "name": "Diffusion" }),
        json!({ "id": "d2", "name": "Robotics" }),
    ]
}

#[test]
fn v27_keeps_an_arxiv_paper_rekeyed_with_its_reading_state() {
    let (papers, push) = v27_papers(&[old_paper(json!({}))], &decks(), NOW);
    assert_eq!(
        serde_json::to_value(&papers).unwrap(),
        json!([{ "id": "2006.11239", "title": "T", "authors": "A", "year": 2020, "url": "https://arxiv.org/abs/2006.11239",
                 "folderIds": [], "progressPercent": 40.0, "leftOff": "§3", "addedAt": 1, "updatedAt": 2, "lastReadAt": 3 }])
    );
    assert_eq!(
        push,
        [PushItem {
            id: "2006.11239".into(),
            folder: "Diffusion".into()
        }]
    );
}

#[test]
fn v27_finds_the_id_through_the_pdf_url() {
    let pdf = json!({ "url": "https://arxiv.org/pdf/2406.09246", "page": 3, "pageCount": 20, "offset": 0.2 });
    let (papers, _) = v27_papers(
        &[old_paper(
            json!({ "url": "https://openvla.github.io", "pdf": pdf }),
        )],
        &decks(),
        NOW,
    );
    assert_eq!(papers[0].id, "2406.09246");
    assert_eq!(papers[0].pdf.as_ref().unwrap().page, 3);
}

#[test]
fn v27_drops_non_arxiv_and_malformed_papers() {
    let (papers, push) = v27_papers(
        &[
            old_paper(json!({ "url": "https://doi.org/10.1145/3290605" })),
            old_paper(json!({ "url": "https://example.com/p.pdf" })),
            Value::Null,
            json!("junk"),
            json!(7),
        ],
        &decks(),
        NOW,
    );
    assert!(papers.is_empty() && push.is_empty());
}

#[test]
fn v27_keeps_the_first_record_and_files_lost_decks_under_want_to_read() {
    let (papers, push) = v27_papers(
        &[
            old_paper(json!({ "deckId": "d1" })),
            old_paper(json!({ "deckId": "d2", "url": "https://arxiv.org/pdf/2006.11239" })),
        ],
        &decks(),
        NOW,
    );
    assert_eq!(papers.len(), 1);
    assert_eq!(
        push,
        [PushItem {
            id: "2006.11239".into(),
            folder: "Diffusion".into()
        }]
    );
    let (papers, push) = v27_papers(
        &[old_paper(json!({ "deckId": "missing", "title": "" }))],
        &decks(),
        NOW,
    );
    assert_eq!(
        (papers[0].title.as_str(), push[0].folder.as_str()),
        ("2006.11239", "Want to read")
    );
}

#[test]
fn v27_annotations_and_focus_session() {
    let a = |k: &str| json!({ "id": k, "docKey": k });
    let kept = v27_annotations(&[
        a("arxiv:2006.11239"),
        a("doi:10.1/x"),
        a("url:example.com/p"),
        Value::Null,
    ]);
    assert_eq!(kept, [a("arxiv:2006.11239")]);
    assert_eq!(
        v27_focus_session(Some(
            &json!({ "startedAt": 1, "phase": "focus", "phaseEndsAt": 9, "round": 1 })
        )),
        Value::Null
    );
    assert_eq!(v27_focus_session(None), Value::Null);
    let reading = json!({ "startedAt": 1, "tabIds": [4], "title": "T" });
    assert_eq!(v27_focus_session(Some(&reading)), reading);
}

#[test]
fn clears_dead_session_keys_even_on_a_current_profile() {
    let plan = migrate(
        &obj(json!({ "schemaVersion": SCHEMA_VERSION })),
        NOW,
        no_ids(),
    );
    assert_eq!(plan.session_remove, DEAD_SESSION_KEYS);
    assert!(plan.set.is_empty() && plan.remove.is_empty());
}

fn sentinel(k: &str) -> Value {
    json!({ "sentinel": k, "nested": [1, { "deep": k }] })
}
fn legacy_profile() -> Map<String, Value> {
    let mut db: Map<String, Value> = LIVE_KEYS
        .iter()
        .map(|k| (k.to_string(), sentinel(k)))
        .collect();
    db.extend(obj(json!({
        "schemaVersion": 26,
        "settings": { "readerFocusLine": true, "claudeKey": "sk", "focusBlocklist": ["x.com"],
                      "displayName": "A", "ollamaUrl": "u", "cloudMode": "all", "mutedTopics": ["x"], "trackTopics": ["y"],
                      "geminiTopicKey": "g", "focusMinutes": 50, "breakMinutes": 10, "focusSound": true,
                      "semanticScholarApiKey": "s", "refreshInterval": 30, "notificationsEnabled": true,
                      "theme": "paperwhite", "readerNight": true },
        "papers": [
            { "id": "p1", "deckId": "d1", "title": "P", "url": "https://arxiv.org/abs/2006.11239", "status": "reading", "progressPercent": 20 },
            { "id": "p2", "deckId": "d1", "title": "W", "url": "https://example.com/w.pdf", "status": "to-read", "progressPercent": 0 }
        ],
        "decks": [{ "id": "d1", "name": "Diffusion" }],
        "annotations": [{ "id": "a1", "docKey": "arxiv:2006.11239" }, { "id": "a2", "docKey": "url:example.com/w.pdf" }],
        "focusSession": { "startedAt": 1, "phase": "focus", "phaseEndsAt": 2, "round": 1 },
        "feeds": ["https://lwn.net/feed"], "readingProgress": { "a": {} }, "provocations": [{ "id": "q" }], "aiVectors": { "a": "v" }
    })));
    db.remove("alphaxivPush");
    db
}

#[test]
fn a_legacy_profile_drops_only_the_cut_and_lands_on_the_current_schema() {
    let before = legacy_profile();
    let after = apply(&before, &migrate(&before, NOW, no_ids()));
    for gone in [
        "feeds",
        "readingProgress",
        "provocations",
        "aiVectors",
        "decks",
    ] {
        assert!(!after.contains_key(gone), "{gone}");
    }
    assert_eq!(
        after["settings"],
        json!({ "readerFocusLine": true, "claudeKey": "sk", "focusBlocklist": ["x.com"] })
    );
    assert_eq!(
        after["papers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["2006.11239"]
    );
    assert_eq!(
        after["alphaxivPush"],
        json!([{ "id": "2006.11239", "folder": "Diffusion" }])
    );
    assert_eq!(
        after["annotations"],
        json!([{ "id": "a1", "docKey": "arxiv:2006.11239" }])
    );
    assert_eq!(after["focusSession"], Value::Null);
    for k in LIVE_KEYS {
        if ![
            "schemaVersion",
            "settings",
            "papers",
            "alphaxivPush",
            "annotations",
            "focusSession",
        ]
        .contains(k)
        {
            assert_eq!(after[*k], sentinel(k), "{k} must be untouched");
        }
    }
    assert_eq!(after["schemaVersion"], json!(SCHEMA_VERSION));
}

#[test]
fn migrate_is_idempotent() {
    let before = legacy_profile();
    let first = apply(&before, &migrate(&before, NOW, no_ids()));
    // Force every step to run again rather than pass on the version guard.
    let mut again = first.clone();
    again.insert("schemaVersion".into(), json!(26));
    let second = apply(&again, &migrate(&again, NOW + 1, no_ids()));
    assert_eq!(second, first);
}

#[test]
fn a_fresh_profile_only_gets_a_schema_version_and_empty_rewrites() {
    let after = apply(&Map::new(), &migrate(&Map::new(), NOW, no_ids()));
    assert_eq!(after["schemaVersion"], json!(SCHEMA_VERSION));
    assert_eq!(after["papers"], json!([]));
    assert_eq!(after["dumps"], json!([]));
}
