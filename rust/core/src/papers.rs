//! Recognising papers from links and ids (src/shared/papers.ts).

use regex::Regex;
use std::sync::LazyLock;

// `LazyLock`: compiled once, on first use, then shared; the Rust spelling of a
// module-level `const RE = /…/`.
static ARXIV_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:arxiv|alphaxiv)\.org/(?:abs|pdf|overview)/([^\s?#]+)").unwrap()
});
static PDF_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.pdf$").unwrap());
static NEW_STYLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(\d{4}\.\d{4,5})(v\d+)?$").unwrap());
static OLD_STYLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^([a-z-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?$").unwrap());
static DOI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(10\.\d{4,9}/[^\s?#]+)").unwrap());
static HTTP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^https?://").unwrap());

/// A pasted reference as a typed key: `arXiv:<id>`, `DOI:<doi>` or `URL:<url>`;
/// `None` when there is nothing usable. arXiv ids (new `2006.11239` and legacy
/// `hep-th/9901001`, bare or inside arxiv.org / alphaxiv.org abs, pdf or
/// overview links) lose their version and `.pdf` suffix.
pub fn parse_paper_ref(input: &str) -> Option<String> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }
    let candidate = ARXIV_URL
        .captures(raw)
        .map_or(raw, |c| c.get(1).map_or(raw, |m| m.as_str()));
    let candidate = PDF_SUFFIX.replace(candidate, "");
    if let Some(c) = NEW_STYLE
        .captures(&candidate)
        .or_else(|| OLD_STYLE.captures(&candidate))
    {
        return Some(format!("arXiv:{}", &c[1]));
    }
    if let Some(c) = DOI.captures(raw) {
        return Some(format!("DOI:{}", &c[1]));
    }
    HTTP.is_match(raw).then(|| format!("URL:{raw}"))
}

/// A stable key for matching a tab's URL to a stored paper: arXiv ids and DOIs
/// collapse their link variants; other links normalise host and path (no
/// scheme, `www.`, query, hash or trailing slash).
pub fn paper_match_key(url: &str) -> Option<String> {
    let reference = parse_paper_ref(url)?;
    if !reference.starts_with("URL:") {
        return Some(reference.to_lowercase());
    }
    let u = url::Url::parse(url).ok()?;
    let host = u.host_str()?;
    let host = strip_prefix_ignore_case(host, "www.");
    let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
    Some(format!("url:{host}{port}{}", u.path().trim_end_matches('/')).to_lowercase())
}

/// The bare arXiv id in a link or id, or `None` when it is not arXiv.
pub fn arxiv_id(input: &str) -> Option<String> {
    parse_paper_ref(input)?
        .strip_prefix("arXiv:")
        .map(str::to_string)
}

pub(crate) fn strip_prefix_ignore_case<'a>(s: &'a str, prefix: &str) -> &'a str {
    match s.get(..prefix.len()) {
        Some(head) if head.eq_ignore_ascii_case(prefix) => &s[prefix.len()..],
        _ => s,
    }
}

/// Papers by alphaXiv folder id, most recently read first within each (a
/// paper in two folders is listed in both).
pub fn group_by_folder(
    papers: &[crate::types::Paper],
) -> std::collections::HashMap<String, Vec<crate::types::Paper>> {
    let mut map: std::collections::HashMap<String, Vec<crate::types::Paper>> = Default::default();
    for p in papers {
        for id in &p.folder_ids {
            map.entry(id.clone()).or_default().push(p.clone());
        }
    }
    for list in map.values_mut() {
        list.sort_by_key(|p| std::cmp::Reverse(p.last_read_at.unwrap_or(0)));
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_arxiv_abs_pdf_versioned_and_pdf_suffix_as_the_same_id() {
        for input in [
            "https://arxiv.org/abs/2006.11239",
            "https://arxiv.org/pdf/2006.11239",
            "https://arxiv.org/pdf/2006.11239.pdf",
            "https://arxiv.org/abs/2006.11239v3",
            "2006.11239",
        ] {
            assert_eq!(
                parse_paper_ref(input).as_deref(),
                Some("arXiv:2006.11239"),
                "{input}"
            );
        }
    }

    #[test]
    fn recognizes_an_alphaxiv_link_as_its_arxiv_id() {
        for input in [
            "https://www.alphaxiv.org/abs/2605.02881",
            "https://www.alphaxiv.org/abs/2605.02881v2",
            "https://www.alphaxiv.org/overview/2605.02881",
            "alphaxiv.org/pdf/2605.02881",
        ] {
            assert_eq!(
                parse_paper_ref(input).as_deref(),
                Some("arXiv:2605.02881"),
                "{input}"
            );
        }
    }

    #[test]
    fn recognizes_legacy_arxiv_ids_and_dois() {
        assert_eq!(
            parse_paper_ref("hep-th/9901001").as_deref(),
            Some("arXiv:hep-th/9901001")
        );
        assert_eq!(
            parse_paper_ref("https://doi.org/10.1145/3292500.3330701").as_deref(),
            Some("DOI:10.1145/3292500.3330701")
        );
    }

    #[test]
    fn falls_back_to_url_for_other_links_none_for_junk() {
        assert_eq!(
            parse_paper_ref("https://example.com/paper").as_deref(),
            Some("URL:https://example.com/paper")
        );
        assert_eq!(parse_paper_ref("just some text"), None);
        assert_eq!(parse_paper_ref(""), None);
    }

    #[test]
    fn match_key_collapses_arxiv_variants() {
        let key = paper_match_key("https://arxiv.org/abs/2006.11239");
        assert_eq!(paper_match_key("https://arxiv.org/pdf/2006.11239.pdf"), key);
        assert_eq!(paper_match_key("https://arxiv.org/abs/2006.11239v2"), key);
    }

    #[test]
    fn match_key_normalizes_plain_urls() {
        let a = paper_match_key("https://example.com/papers/x/");
        assert_eq!(
            paper_match_key("http://www.example.com/papers/x?ref=1#sec2"),
            a
        );
        assert_ne!(paper_match_key("https://example.com/papers/y"), a);
    }

    #[test]
    fn match_key_is_none_for_unmatchable_input() {
        assert_eq!(paper_match_key("not a url"), None);
    }

    #[test]
    fn arxiv_id_pulls_the_bare_id() {
        assert_eq!(
            arxiv_id("https://arxiv.org/abs/2006.11239v2").as_deref(),
            Some("2006.11239")
        );
        assert_eq!(
            arxiv_id("https://arxiv.org/pdf/2006.11239.pdf").as_deref(),
            Some("2006.11239")
        );
        assert_eq!(
            arxiv_id("https://www.alphaxiv.org/overview/2406.09246").as_deref(),
            Some("2406.09246")
        );
        assert_eq!(
            arxiv_id("hep-th/9901001").as_deref(),
            Some("hep-th/9901001")
        );
    }

    #[test]
    fn arxiv_id_is_none_for_dois_other_links_and_junk() {
        assert_eq!(arxiv_id("10.1145/3290605"), None);
        assert_eq!(arxiv_id("https://example.com/paper.pdf"), None);
        assert_eq!(arxiv_id(""), None);
    }

    #[test]
    fn groups_by_folder_most_recently_read_first() {
        let paper = |id: &str, folders: &[&str], read: Option<i64>| crate::types::Paper {
            id: id.into(),
            folder_ids: folders.iter().map(|f| f.to_string()).collect(),
            last_read_at: read,
            ..Default::default()
        };
        let by = group_by_folder(&[
            paper("a", &["x"], Some(1)),
            paper("b", &["x", "y"], Some(5)),
            paper("c", &["x"], None),
        ]);
        let ids = |f: &str| by[f].iter().map(|p| p.id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids("x"), ["b", "a", "c"]);
        assert_eq!(ids("y"), ["b"]);
    }
}
