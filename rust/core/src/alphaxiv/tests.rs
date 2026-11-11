//! Contract tests against replies recorded from a real alphaXiv account
//! (fixtures/, ids swapped for public stand-ins), and the pure rules.

use super::*;
use serde_json::json;

const NOW: i64 = 1_800_000_000_000;
const LIST_LIBRARY: &str = include_str!("../../fixtures/list_library.json");
const HOT_FEED: &str = include_str!("../../fixtures/hot_feed.json");
const FOR_YOU_FEED: &str = include_str!("../../fixtures/for_you_feed.json");
const AUTH_METADATA: &str = include_str!("../../fixtures/auth_metadata.json");
const REGISTER_REPLY: &str = include_str!("../../fixtures/register_reply.json");
const READING: &str = "01985f0e-9788-7c5f-9cff-000000000002";
const TO_READ: &str = "01985f0e-9788-7673-a495-000000000001";

fn paper(id: &str) -> Paper {
    Paper {
        id: id.into(),
        title: format!("Paper {id}"),
        authors: String::new(),
        year: Some(2024),
        url: format!("https://arxiv.org/abs/{id}"),
        folder_ids: vec![],
        progress_percent: 0.0,
        left_off: String::new(),
        pdf: None,
        added_at: 1,
        updated_at: 1,
        last_read_at: None,
    }
}
fn lib() -> Library {
    parse_library(LIST_LIBRARY).unwrap()
}
fn lp(id: &str, title: &str) -> LibraryPaper {
    LibraryPaper {
        universal_paper_id: id.into(),
        title: title.into(),
        kind: None,
        publication_date: None,
    }
}
fn folder(id: &str, papers: Vec<LibraryPaper>, truncated: bool) -> LibraryFolder {
    LibraryFolder {
        folder_id: id.into(),
        name: id.to_uppercase(),
        kind: "custom".into(),
        papers,
        papers_truncated: truncated,
    }
}

// ---------- contract ----------

#[test]
fn our_endpoints_are_the_ones_the_server_publishes() {
    let meta: serde_json::Value = serde_json::from_str(AUTH_METADATA).unwrap();
    assert_eq!(meta["authorization_endpoint"], AUTHORIZE_URL);
    assert_eq!(meta["token_endpoint"], TOKEN_URL);
    assert_eq!(meta["registration_endpoint"], REGISTER_URL);
    assert_eq!(meta["userinfo_endpoint"], USERINFO_URL);
    assert_eq!(meta["revocation_endpoint"], REVOKE_URL);
    assert!(meta["code_challenge_methods_supported"]
        .as_array()
        .unwrap()
        .contains(&json!("S256")));
    assert!(meta["token_endpoint_auth_methods_supported"]
        .as_array()
        .unwrap()
        .contains(&json!("none")));
    let reg: serde_json::Value = serde_json::from_str(REGISTER_REPLY).unwrap();
    assert_eq!(reg["public"], true);
}

#[test]
fn parses_list_library() {
    let l = lib();
    assert_eq!(
        l.folders
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>(),
        ["Want to read", "Reading", "Completed", "My publications"]
    );
    assert_eq!(
        l.folders[1]
            .papers
            .iter()
            .map(|p| p.universal_paper_id.as_str())
            .collect::<Vec<_>>(),
        ["1706.03762", "2110.14168"]
    );
}

#[test]
fn parses_both_feeds_in_order() {
    assert_eq!(
        parse_feed(HOT_FEED).unwrap(),
        ["2610.39302", "2610.40564", "2610.40636"]
    );
    assert_eq!(
        parse_feed(FOR_YOU_FEED).unwrap(),
        ["2610.37381", "2610.28480", "2609.24972"]
    );
}

#[test]
fn drops_link_blogs_and_copes_with_an_empty_feed() {
    assert_eq!(
        parse_feed(
            r#"{"papers":[{"universal_paper_id":"blog-abc"},{"universal_paper_id":"1706.03762"}]}"#
        )
        .unwrap(),
        ["1706.03762"]
    );
    assert!(parse_feed(r#"{"papers":[]}"#).unwrap().is_empty());
}

#[test]
fn non_json_or_a_changed_shape_is_a_failed_error() {
    for text in [
        "The user has no notes on [ID=1].",
        r#"{"folders":"nope"}"#,
        "{}",
    ] {
        assert_eq!(
            parse_library(text).unwrap_err().kind,
            ErrorKind::Failed,
            "{text}"
        );
    }
    assert_eq!(parse_feed("<html>").unwrap_err().kind, ErrorKind::Failed);
}

#[test]
fn finds_the_folder_id_whatever_the_wording() {
    assert_eq!(
        parse_folder_id(
            r#"Created folder "Diffusion" [folder_id=01985f0e-9788-7673-a495-c113dd5ac4be]."#
        )
        .as_deref(),
        Some("01985f0e-9788-7673-a495-c113dd5ac4be")
    );
    assert_eq!(
        parse_folder_id(r#"{"folder_id":"01985F0E-9788-7673-A495-C113DD5AC4BE"}"#).as_deref(),
        Some("01985F0E-9788-7673-A495-C113DD5AC4BE")
    );
    assert_eq!(parse_folder_id("Folder created."), None);
}

// ---------- OAuth ----------

#[test]
fn pkce_s256_matches_rfc_7636_appendix_b() {
    assert_eq!(
        pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
}

#[test]
fn base64url_has_no_padding_or_unsafe_characters() {
    assert_eq!(base64url(&[251, 255, 254]), "-__-");
    assert_eq!(base64url(b"f"), "Zg");
    assert_eq!(base64url(b"fo"), "Zm8");
    assert_eq!(base64url(b""), "");
}

#[test]
fn authorize_asks_for_pkce_a_refresh_token_and_the_mcp_resource() {
    let u = url::Url::parse(&authorize_url(
        "c",
        "https://x.chromiumapp.org/alphaxiv",
        "s",
        "ch",
    ))
    .unwrap();
    assert_eq!(
        format!("{}://{}{}", u.scheme(), u.host_str().unwrap(), u.path()),
        AUTHORIZE_URL
    );
    let q: BTreeMap<String, String> = u.query_pairs().into_owned().collect();
    let want: BTreeMap<String, String> = [
        ("response_type", "code"),
        ("client_id", "c"),
        ("redirect_uri", "https://x.chromiumapp.org/alphaxiv"),
        ("scope", "openid profile email offline_access"),
        ("state", "s"),
        ("code_challenge", "ch"),
        ("code_challenge_method", "S256"),
        ("resource", MCP_URL),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    assert_eq!(q, want);
}

#[test]
fn takes_the_code_only_when_the_state_matches() {
    let base = "https://x.chromiumapp.org/alphaxiv";
    assert_eq!(
        code_from_redirect(&format!("{base}?code=abc&state=s1"), "s1"),
        Ok("abc".into())
    );
    assert!(code_from_redirect(&format!("{base}?code=abc&state=forged"), "s1").is_err());
    assert_eq!(
        code_from_redirect(
            &format!("{base}?error=access_denied&error_description=User+said+no&state=s1"),
            "s1"
        ),
        Err("User said no".into())
    );
    assert!(code_from_redirect(&format!("{base}?state=s1"), "s1").is_err());
    assert!(code_from_redirect("not a url", "s1").is_err());
}

#[test]
fn stores_a_token_reply_a_minute_short_of_expiry() {
    let auth = auth_from_token_reply(&json!({ "access_token": "a", "refresh_token": "r", "expires_in": 3600, "token_type": "bearer" }), "c", "u", None, NOW).unwrap();
    assert_eq!(
        auth,
        AlphaxivAuth {
            client_id: "c".into(),
            redirect_uri: "u".into(),
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: NOW + 3_540_000
        }
    );
    assert!(!needs_refresh(&auth, NOW + 3_539_000));
    assert!(needs_refresh(&auth, NOW + 3_540_000));
}

#[test]
fn keeps_the_old_refresh_token_when_not_rotated() {
    let auth = auth_from_token_reply(
        &json!({ "access_token": "a2", "expires_in": 60 }),
        "c",
        "u",
        Some("r1"),
        NOW,
    )
    .unwrap();
    assert_eq!((auth.refresh_token.as_str(), auth.expires_at), ("r1", NOW));
}

#[test]
fn refuses_no_access_token_and_accepts_no_refresh_token() {
    assert!(
        auth_from_token_reply(&json!({ "error": "invalid_grant" }), "c", "u", None, NOW).is_err()
    );
    assert_eq!(
        auth_from_token_reply(&json!({ "access_token": "a" }), "c", "u", None, NOW)
            .unwrap()
            .refresh_token,
        ""
    );
}

#[test]
fn maps_http_failures_to_what_the_user_can_do() {
    assert_eq!(
        [401, 403, 429, 404, 500].map(kind_for_status),
        [
            ErrorKind::SignedOut,
            ErrorKind::SignedOut,
            ErrorKind::RateLimited,
            ErrorKind::NotFound,
            ErrorKind::Failed
        ]
    );
}

// ---------- merge ----------

#[test]
fn an_empty_shelf_takes_every_folder_and_paper() {
    let (folders, papers) = merge_library(&[], &lib(), NOW);
    assert_eq!(folders.len(), 4);
    let mut ids: Vec<&str> = papers.iter().map(|p| p.id.as_str()).collect();
    ids.sort();
    assert_eq!(
        ids,
        [
            "1706.03762",
            "2110.14168",
            "2406.09246",
            "2410.24164",
            "2506.01844"
        ]
    );
    let attention = papers.iter().find(|p| p.id == "1706.03762").unwrap();
    assert_eq!(
        attention,
        &Paper {
            title: "Attention Is All You Need".into(),
            year: Some(2017),
            folder_ids: vec![READING.into()],
            added_at: NOW,
            updated_at: NOW,
            ..paper("1706.03762")
        }
    );
}

#[test]
fn never_touches_local_reading_state() {
    let mine = Paper {
        progress_percent: 60.0,
        left_off: "3.2 Attention".into(),
        last_read_at: Some(5),
        pdf: Some(crate::types::PdfState {
            url: "u".into(),
            page: 4,
            page_count: 15,
            offset: 0.3,
        }),
        ..paper("1706.03762")
    };
    let (_, papers) = merge_library(std::slice::from_ref(&mine), &lib(), NOW);
    let merged = papers.iter().find(|p| p.id == mine.id).unwrap();
    assert_eq!(
        (
            merged.progress_percent,
            merged.left_off.as_str(),
            merged.last_read_at,
            &merged.pdf
        ),
        (60.0, "3.2 Attention", Some(5), &mine.pdf)
    );
    assert_eq!(merged.folder_ids, [READING]);
}

#[test]
fn an_unchanged_record_keeps_its_updated_at() {
    let (_, first) = merge_library(&[], &lib(), NOW);
    let (_, second) = merge_library(&first, &lib(), NOW + 1);
    assert_eq!(first, second);
}

#[test]
fn a_paper_moved_on_alphaxiv_moves_on_the_shelf() {
    let mut moved = lib();
    for f in &mut moved.folders {
        if f.folder_id == READING {
            f.papers.clear();
        } else if f.folder_id == TO_READ {
            f.papers.push(lp("1706.03762", "Attention Is All You Need"));
        }
    }
    let (_, papers) = merge_library(
        &[Paper {
            folder_ids: vec![READING.into()],
            ..paper("1706.03762")
        }],
        &moved,
        NOW,
    );
    assert_eq!(
        papers
            .iter()
            .find(|p| p.id == "1706.03762")
            .unwrap()
            .folder_ids,
        [TO_READ]
    );
}

#[test]
fn a_paper_in_two_folders_sits_on_both_once() {
    let twice = Library {
        folders: vec![
            folder("a", vec![lp("1706.03762", "T")], false),
            folder("b", vec![lp("1706.03762", "T")], false),
        ],
    };
    let (_, papers) = merge_library(&[], &twice, NOW);
    assert_eq!(papers.len(), 1);
    assert_eq!(papers[0].folder_ids, ["a", "b"]);
}

#[test]
fn a_dropped_paper_leaves_the_shelf_but_keeps_progress() {
    let mine = Paper {
        folder_ids: vec![READING.into()],
        progress_percent: 40.0,
        ..paper("9999.99999")
    };
    let (_, papers) = merge_library(&[mine], &lib(), NOW);
    let merged = papers.iter().find(|p| p.id == "9999.99999").unwrap();
    assert!(merged.folder_ids.is_empty());
    assert_eq!(merged.progress_percent, 40.0);
}

#[test]
fn a_renamed_folder_keeps_its_papers_a_deleted_one_releases_them() {
    let mut renamed = lib();
    renamed
        .folders
        .iter_mut()
        .find(|f| f.folder_id == READING)
        .unwrap()
        .name = "Now reading".into();
    let (folders, papers) = merge_library(
        &[Paper {
            folder_ids: vec![READING.into()],
            ..paper("1706.03762")
        }],
        &renamed,
        NOW,
    );
    assert_eq!(
        folders.iter().find(|f| f.id == READING).unwrap().name,
        "Now reading"
    );
    assert_eq!(
        papers
            .iter()
            .find(|p| p.id == "1706.03762")
            .unwrap()
            .folder_ids,
        [READING]
    );
    let mut deleted = lib();
    deleted.folders.retain(|f| f.folder_id != READING);
    let (_, papers) = merge_library(
        &[Paper {
            folder_ids: vec![READING.into()],
            ..paper("1706.03762")
        }],
        &deleted,
        NOW,
    );
    assert!(papers[0].folder_ids.is_empty());
}

#[test]
fn a_truncated_folder_keeps_memberships_the_reply_cannot_show() {
    let cut = Library {
        folders: vec![folder("big", vec![lp("1706.03762", "T")], true)],
    };
    let (_, papers) = merge_library(
        &[Paper {
            folder_ids: vec!["big".into()],
            ..paper("2006.11239")
        }],
        &cut,
        NOW,
    );
    assert_eq!(
        papers
            .iter()
            .find(|p| p.id == "2006.11239")
            .unwrap()
            .folder_ids,
        ["big"]
    );
}

#[test]
fn skips_uploads_and_non_arxiv_ids_and_an_empty_library_empties_the_shelf() {
    let upload = |id: &str| LibraryPaper {
        kind: Some("private".into()),
        ..lp(id, "My draft")
    };
    let odd = Library {
        folders: vec![folder(
            "a",
            vec![upload("upload-123"), upload("1706.03762")],
            false,
        )],
    };
    assert!(merge_library(&[], &odd, NOW).1.is_empty());
    let (folders, papers) = merge_library(
        &[Paper {
            folder_ids: vec!["a".into()],
            ..paper("1706.03762")
        }],
        &Library { folders: vec![] },
        NOW,
    );
    assert!(folders.is_empty());
    assert!(papers[0].folder_ids.is_empty());
}

#[test]
fn a_blank_remote_title_or_missing_date_keeps_the_local_one() {
    let blank = Library {
        folders: vec![folder(
            "a",
            vec![LibraryPaper {
                publication_date: None,
                ..lp("1706.03762", "  ")
            }],
            false,
        )],
    };
    let (_, papers) = merge_library(
        &[Paper {
            title: "Attention".into(),
            year: Some(2017),
            ..paper("1706.03762")
        }],
        &blank,
        NOW,
    );
    assert_eq!(
        (papers[0].title.as_str(), papers[0].year),
        ("Attention", Some(2017))
    );
}

// ---------- push ----------

fn folders() -> Vec<Folder> {
    vec![
        Folder {
            id: "f-to-read".into(),
            name: "Want to read".into(),
            kind: "default-to-read".into(),
        },
        Folder {
            id: "f-diff".into(),
            name: "Diffusion".into(),
            kind: "custom".into(),
        },
    ]
}
fn item(id: &str, folder: &str) -> PushItem {
    PushItem {
        id: id.into(),
        folder: folder.into(),
    }
}

#[test]
fn saves_into_existing_folders_by_name_and_creates_the_rest() {
    let plan = plan_push(
        &[
            item("2006.11239", "diffusion "),
            item("1706.03762", "Transformers"),
            item("2406.09246", "Want  to read"),
        ],
        &folders(),
        &[],
    );
    assert_eq!(plan.create, ["Transformers"]);
    assert_eq!(
        plan.saves,
        vec![
            ("Diffusion".into(), vec!["2006.11239".into()]),
            ("Transformers".into(), vec!["1706.03762".into()]),
            ("Want to read".into(), vec!["2406.09246".into()])
        ]
    );
}

#[test]
fn skips_papers_already_there_and_duplicates() {
    let plan = plan_push(
        &[
            item("2006.11239", "Diffusion"),
            item("2006.11239", "Diffusion"),
        ],
        &folders(),
        &[Paper {
            folder_ids: vec!["f-diff".into()],
            ..paper("2006.11239")
        }],
    );
    assert_eq!(plan, PushPlan::default());
    assert_eq!(
        plan_push(&[item("a", "X"), item("a", "x")], &[], &[]).saves,
        vec![("X".to_string(), vec!["a".to_string()])]
    );
}

#[test]
fn a_new_folder_is_named_the_same_whatever_the_queue_order() {
    let a = plan_push(
        &[item("a", "x"), item("b", "X  "), item("c", "Y")],
        &[],
        &[],
    );
    let b = plan_push(&[item("c", "Y"), item("b", " X"), item("a", "x")], &[], &[]);
    assert_eq!(a.create, ["X", "Y"]);
    assert_eq!(b.create, a.create);
    let names = |p: &PushPlan| p.saves.iter().map(|s| s.0.clone()).collect::<Vec<_>>();
    assert_eq!(names(&a), names(&b));
    // Inner spaces collapse too: "My  deck" is created as "My deck".
    assert_eq!(
        plan_push(&[item("a", "My  deck")], &[], &[]).create,
        ["My deck"]
    );
}

#[test]
fn a_blank_folder_name_goes_to_want_to_read() {
    assert_eq!(
        plan_push(&[item("a", "  ")], &folders(), &[]).saves,
        vec![("Want to read".to_string(), vec!["a".to_string()])]
    );
    // With no such folder yet it is created under that name, not as "".
    let plan = plan_push(&[item("a", "  ")], &[], &[]);
    assert_eq!(plan.create, ["Want to read"]);
    assert_eq!(
        plan.saves,
        vec![("Want to read".to_string(), vec!["a".to_string()])]
    );
}

#[test]
fn batches_at_50() {
    let queue: Vec<PushItem> = (0..120)
        .map(|i| item(&format!("2401.{i:05}"), "Diffusion"))
        .collect();
    assert_eq!(
        plan_push(&queue, &folders(), &[])
            .saves
            .iter()
            .map(|s| s.1.len())
            .collect::<Vec<_>>(),
        [50, 50, 20]
    );
}

#[test]
fn an_empty_queue_is_an_empty_plan() {
    assert_eq!(plan_push(&[], &folders(), &[]), PushPlan::default());
    assert_eq!(folder_key("  A   b "), "a b");
}
