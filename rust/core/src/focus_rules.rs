//! The reading session's blocking rules (src/shared/focusRules.ts). The
//! extension turns these into declarativeNetRequest session rules; deciding
//! what they are is pure.

use crate::constants::{FOCUS_DNR_ID_BASE, FOCUS_DNR_PRIORITY};
use crate::papers::strip_prefix_ignore_case;
use crate::types::FocusSession;
use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

static DOMAIN_SHAPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9-]+(\.[a-z0-9-]+)+$").unwrap());

/// User input → canonical blocklist domain, or `None` if unusable.
pub fn normalize_block_domain(input: &str) -> Option<String> {
    let raw = input.trim().to_lowercase();
    if raw.is_empty() {
        return None;
    }
    let with_scheme = if raw.contains("://") {
        raw
    } else {
        format!("https://{raw}")
    };
    let host = url::Url::parse(&with_scheme).ok()?.host_str()?.to_string();
    let host = strip_prefix_ignore_case(&host, "www.").to_string();
    DOMAIN_SHAPE.is_match(&host).then_some(host)
}

/// DNR `requestDomains` semantics: the exact host or any subdomain.
pub fn is_blocked_host(host: &str, domains: &[String]) -> bool {
    let h = host.to_lowercase();
    let h = strip_prefix_ignore_case(&h, "www.");
    domains
        .iter()
        .any(|d| h == d || h.ends_with(&format!(".{d}")))
}

/// A declarativeNetRequest rule, as `chrome.declarativeNetRequest` takes it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnrRule {
    pub id: i64,
    pub priority: i64,
    pub action: DnrAction,
    pub condition: DnrCondition,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnrAction {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redirect: Option<DnrRedirect>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnrRedirect {
    pub regex_substitution: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnrCondition {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_domains: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub regex_filter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_filter: Option<String>,
    pub resource_types: Vec<String>,
}

/// One redirect rule per domain, carrying the blocked URL in the hash so the
/// blocked page can offer "continue" once the session ends.
pub fn build_focus_rules(domains: &[String], redirect_base: &str) -> Vec<DnrRule> {
    domains
        .iter()
        .enumerate()
        .map(|(i, domain)| DnrRule {
            id: FOCUS_DNR_ID_BASE + i as i64,
            priority: FOCUS_DNR_PRIORITY,
            action: DnrAction {
                kind: "redirect".into(),
                redirect: Some(DnrRedirect {
                    regex_substitution: format!("{redirect_base}#\\0"),
                }),
            },
            condition: DnrCondition {
                request_domains: Some(vec![domain.clone()]),
                regex_filter: Some("^https?://.*".into()),
                resource_types: vec!["main_frame".into()],
                ..Default::default()
            },
        })
        .collect()
}

/// The session's whole rule set: the blocklist redirects while a reader tab is
/// open, nothing otherwise. Rebuilt atomically on every change.
pub fn build_session_access_rules(
    session: Option<&FocusSession>,
    domains: &[String],
    redirect_base: &str,
) -> Vec<DnrRule> {
    if is_blocking(session) {
        build_focus_rules(domains, redirect_base)
    } else {
        vec![]
    }
}

/// Session rule ids this module owns: the retired gate's allow rule and the focus range.
pub fn is_owned_session_rule(id: i64) -> bool {
    id == crate::constants::DAILY_GATE_ALLOW_DNR_ID
        || (FOCUS_DNR_ID_BASE..crate::constants::FOCUS_DNR_ID_LIMIT).contains(&id)
}

/// A reader tab opened: start the session, or add the tab to it.
pub fn with_reader_tab(
    session: Option<FocusSession>,
    tab_id: i32,
    title: &str,
    now: i64,
) -> FocusSession {
    match session {
        None => FocusSession {
            started_at: now,
            tab_ids: vec![tab_id],
            title: title.into(),
        },
        Some(mut s) => {
            if !s.tab_ids.contains(&tab_id) {
                s.tab_ids.push(tab_id);
            }
            if !title.is_empty() {
                s.title = title.into();
            }
            s
        }
    }
}

/// A reader tab closed or left: `None` once no reader tab is left.
pub fn without_reader_tab(session: Option<FocusSession>, tab_id: i32) -> Option<FocusSession> {
    let mut s = session?;
    s.tab_ids.retain(|&id| id != tab_id);
    (!s.tab_ids.is_empty()).then_some(s)
}

/// Rules are on exactly when a session holds a reader tab.
pub fn is_blocking(session: Option<&FocusSession>) -> bool {
    session.is_some_and(|s| !s.tab_ids.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_passes_clean_domains_and_strips_the_rest() {
        assert_eq!(
            normalize_block_domain("netflix.com").as_deref(),
            Some("netflix.com")
        );
        assert_eq!(
            normalize_block_domain("mail.google.com").as_deref(),
            Some("mail.google.com")
        );
        assert_eq!(
            normalize_block_domain("https://www.Netflix.com/browse").as_deref(),
            Some("netflix.com")
        );
        assert_eq!(
            normalize_block_domain("http://linkedin.com:443/feed/").as_deref(),
            Some("linkedin.com")
        );
        assert_eq!(
            normalize_block_domain("www.hulu.com").as_deref(),
            Some("hulu.com")
        );
        assert_eq!(
            normalize_block_domain("  AMAZON.COM  ").as_deref(),
            Some("amazon.com")
        );
        assert_eq!(
            normalize_block_domain("news.ycombinator.com").as_deref(),
            Some("news.ycombinator.com")
        );
    }

    #[test]
    fn normalize_rejects_garbage() {
        for bad in ["", "   ", "not a domain", "localhost", "http://"] {
            assert_eq!(normalize_block_domain(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn blocked_hosts_match_exactly_or_as_subdomains_only() {
        let domains = vec!["netflix.com".to_string(), "mail.google.com".to_string()];
        for yes in [
            "netflix.com",
            "www.netflix.com",
            "help.netflix.com",
            "mail.google.com",
        ] {
            assert!(is_blocked_host(yes, &domains), "{yes}");
        }
        for no in ["notnetflix.com", "google.com", "docs.google.com"] {
            assert!(!is_blocked_host(no, &domains), "{no}");
        }
    }

    #[test]
    fn focus_rules_are_sequential_main_frame_redirects_carrying_the_url() {
        let rules = build_focus_rules(
            &["netflix.com".into(), "hulu.com".into()],
            "chrome-extension://abc/blocked.html",
        );
        assert_eq!(
            rules.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![FOCUS_DNR_ID_BASE, FOCUS_DNR_ID_BASE + 1]
        );
        let json = serde_json::to_value(&rules[0]).unwrap();
        assert_eq!(
            json["condition"]["requestDomains"],
            serde_json::json!(["netflix.com"])
        );
        assert_eq!(
            json["condition"]["resourceTypes"],
            serde_json::json!(["main_frame"])
        );
        assert_eq!(json["condition"]["regexFilter"], "^https?://.*");
        assert!(json["condition"].get("urlFilter").is_none());
        let second = serde_json::to_value(&rules[1]).unwrap();
        assert_eq!(second["action"]["type"], "redirect");
        assert_eq!(
            second["action"]["redirect"]["regexSubstitution"],
            "chrome-extension://abc/blocked.html#\\0"
        );
    }

    #[test]
    fn session_rules_exist_exactly_while_a_reader_tab_is_open() {
        let domains = vec!["netflix.com".to_string()];
        let open = FocusSession {
            started_at: 1,
            tab_ids: vec![5],
            title: "Paper".into(),
        };
        assert_eq!(
            build_session_access_rules(Some(&open), &domains, "r").len(),
            1
        );
        assert!(build_session_access_rules(None, &domains, "r").is_empty());
        let empty = FocusSession {
            tab_ids: vec![],
            ..open
        };
        assert!(build_session_access_rules(Some(&empty), &domains, "r").is_empty());
        assert!(
            is_owned_session_rule(901)
                && is_owned_session_rule(1000)
                && !is_owned_session_rule(2000)
                && !is_owned_session_rule(3000)
        );
    }

    #[test]
    fn starts_a_session_on_the_first_reader_tab() {
        assert_eq!(
            with_reader_tab(None, 3, "A", 10),
            FocusSession {
                started_at: 10,
                tab_ids: vec![3],
                title: "A".into()
            }
        );
    }

    #[test]
    fn adds_a_second_tab_once_keeping_the_start_time() {
        let s1 = with_reader_tab(None, 3, "A", 10);
        let s2 = with_reader_tab(Some(with_reader_tab(Some(s1), 4, "B", 20)), 4, "B", 30);
        assert_eq!(
            s2,
            FocusSession {
                started_at: 10,
                tab_ids: vec![3, 4],
                title: "B".into()
            }
        );
    }

    #[test]
    fn keeps_the_old_title_when_a_tab_reports_none() {
        assert_eq!(
            with_reader_tab(Some(with_reader_tab(None, 3, "A", 1)), 3, "", 2).title,
            "A"
        );
    }

    #[test]
    fn ends_only_when_the_last_tab_goes() {
        let s = with_reader_tab(Some(with_reader_tab(None, 3, "A", 1)), 4, "B", 2);
        assert_eq!(
            without_reader_tab(Some(s.clone()), 3).map(|s| s.tab_ids),
            Some(vec![4])
        );
        assert_eq!(without_reader_tab(without_reader_tab(Some(s), 3), 4), None);
        assert_eq!(without_reader_tab(None, 3), None);
    }

    #[test]
    fn blocks_exactly_while_a_tab_is_held() {
        assert!(!is_blocking(None));
        assert!(!is_blocking(Some(&FocusSession {
            started_at: 1,
            tab_ids: vec![],
            title: String::new()
        })));
        assert!(is_blocking(Some(&FocusSession {
            started_at: 1,
            tab_ids: vec![1],
            title: String::new()
        })));
    }
}
