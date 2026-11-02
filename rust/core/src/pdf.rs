//! The reader's pure helpers (src/shared/pdf.ts): which URLs are PDFs, reader
//! URLs, mapping scroll to a page. The `chrome.runtime.getURL` call stays in
//! the extension; here the extension's base URL is a parameter.

use crate::constants::READER_PAGE_PATH;
use crate::papers::{arxiv_id, strip_prefix_ignore_case};
use crate::types::Paper;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

/// `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

pub fn encode_uri_component(s: &str) -> String {
    utf8_percent_encode(s, URI_COMPONENT).to_string()
}

/// Does this URL look like a PDF? http(s) only, so the reader's own
/// chrome-extension:// URL never matches and interception cannot loop.
pub fn is_pdf_url(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    if u.scheme() != "https" && u.scheme() != "http" {
        return false;
    }
    if u.path().to_ascii_lowercase().ends_with(".pdf") {
        return true;
    }
    let host = strip_prefix_ignore_case(u.host_str().unwrap_or(""), "www.").to_ascii_lowercase();
    ((host == "arxiv.org" || host == "export.arxiv.org") && u.path().starts_with("/pdf/"))
        || (host == "openreview.net" && u.path() == "/pdf")
}

/// The PDF a reader URL's query points at: `?src=` is ours, encoded; `?raw=`
/// comes from the DNR redirect, unencoded, so everything after it is the URL.
pub fn reader_pdf_src(search: &str) -> String {
    if let Some(raw) = search.strip_prefix("?raw=") {
        return raw.to_string();
    }
    url::form_urlencoded::parse(search.trim_start_matches('?').as_bytes())
        .find(|(k, _)| k == "src")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default()
}

/// Extension-relative reader URL (path + query).
pub fn reader_page_path(pdf_url: &str) -> String {
    format!("{READER_PAGE_PATH}?src={}", encode_uri_component(pdf_url))
}

/// The arXiv PDF URL for an id or arXiv link, or `None` when it is not arXiv.
pub fn arxiv_pdf_url(id: &str) -> Option<String> {
    arxiv_id(id).map(|id| format!("https://arxiv.org/pdf/{id}"))
}

/// The alphaXiv page for an arXiv id or link.
pub fn alphaxiv_url(url: &str) -> Option<String> {
    arxiv_id(url).map(|id| format!("https://www.alphaxiv.org/abs/{id}"))
}

/// The PDF the reader should load for a paper: the saved position's URL, the
/// paper's own link if it is a PDF, else the arXiv PDF of an abs link.
pub fn paper_pdf_source(url: &str, pdf: Option<&str>) -> Option<String> {
    if let Some(pdf) = pdf.filter(|p| !p.is_empty()) {
        return Some(pdf.to_string());
    }
    if url.is_empty() {
        return None;
    }
    if is_pdf_url(url) {
        return Some(url.to_string());
    }
    arxiv_pdf_url(url)
}

/// Where "open this paper" goes: the reader when there is a PDF, else the
/// paper's own URL; with `via_alphaxiv` an arXiv paper goes to alphaXiv.
/// `extension_base` is `chrome.runtime.getURL('')`.
pub fn paper_open_url(paper: &Paper, via_alphaxiv: bool, extension_base: &str) -> String {
    if via_alphaxiv {
        if let Some(a) = alphaxiv_url(&paper.url) {
            return a;
        }
    }
    match paper_pdf_source(&paper.url, paper.pdf.as_ref().map(|p| p.url.as_str())) {
        Some(pdf) => format!("{extension_base}{}", reader_page_path(&pdf)),
        None => paper.url.clone(),
    }
}

/// arXiv PDF links (abs pages are left alone). RE2 syntax: Chrome compiles it for DNR.
pub const ARXIV_PDF_FILTER: &str = r"^https?://(www\.|export\.)?arxiv\.org/pdf/.+";

/// The session rule sending arXiv PDFs into the reader, before the request leaves.
pub fn reader_redirect_rule(reader_url: &str) -> crate::focus_rules::DnrRule {
    use crate::focus_rules::{DnrAction, DnrCondition, DnrRedirect, DnrRule};
    DnrRule {
        id: crate::constants::PDF_DNR_ID,
        priority: 1,
        action: DnrAction {
            kind: "redirect".into(),
            redirect: Some(DnrRedirect {
                regex_substitution: format!("{reader_url}?raw=\\0"),
            }),
        },
        condition: DnrCondition {
            regex_filter: Some(ARXIV_PDF_FILTER.into()),
            resource_types: vec!["main_frame".into()],
            ..Default::default()
        },
    }
}

/// "Open in Chrome's viewer" for one URL, for the rest of the session: an allow
/// rule a step above the redirect.
pub fn bypass_rule(url: &str, index: usize) -> crate::focus_rules::DnrRule {
    use crate::focus_rules::{DnrAction, DnrCondition, DnrRule};
    DnrRule {
        id: crate::constants::PDF_BYPASS_DNR_ID_BASE + index as i64,
        priority: 2,
        action: DnrAction {
            kind: "allow".into(),
            redirect: None,
        },
        // ponytail: urlFilter treats * ^ | as syntax, so a URL containing them won't match; escape-free regexFilter if it bites.
        condition: DnrCondition {
            url_filter: Some(format!("|{url}|")),
            resource_types: vec!["main_frame".into()],
            ..Default::default()
        },
    }
}

pub fn is_pdf_rule(id: i64) -> bool {
    (crate::constants::PDF_DNR_ID
        ..crate::constants::PDF_BYPASS_DNR_ID_BASE + crate::constants::MAX_PDF_NATIVE_BYPASS as i64)
        .contains(&id)
}

/// 1-based page and 0-1 offset within it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PdfPosition {
    pub page: u32,
    pub offset: f64,
}

/// The page slab holding `scroll_mid` (content pixels). `tops` are cumulative
/// offsets (gaps included), parallel to `heights`.
pub fn position_from_scroll(tops: &[f64], heights: &[f64], scroll_mid: f64) -> PdfPosition {
    if tops.is_empty() {
        return PdfPosition {
            page: 1,
            offset: 0.0,
        };
    }
    // The last top at or above the midpoint; tops are ascending.
    let index = tops
        .iter()
        .take_while(|&&top| top <= scroll_mid)
        .count()
        .saturating_sub(1);
    let offset = (scroll_mid - tops[index]) / heights[index];
    PdfPosition {
        page: index as u32 + 1,
        offset: offset.clamp(0.0, 1.0),
    }
}

/// Reading progress as 0-100.
pub fn compute_pdf_percent(page: u32, page_count: u32, offset: f64) -> u32 {
    if page_count == 0 {
        return 0;
    }
    // JS Math.round rounds .5 up; f64::round rounds half away from zero, the same for these positives.
    let percent = ((f64::from(page) - 1.0 + offset) / f64::from(page_count) * 100.0).round();
    percent.clamp(0.0, 100.0) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_pdf_url_matches_pdf_paths_with_or_without_a_query() {
        assert!(is_pdf_url("https://example.com/files/paper.pdf"));
        assert!(is_pdf_url("https://example.com/paper.PDF?download=1"));
    }

    #[test]
    fn is_pdf_url_matches_suffixless_arxiv_and_openreview() {
        assert!(is_pdf_url("https://arxiv.org/pdf/2006.11239"));
        assert!(is_pdf_url("https://www.arxiv.org/pdf/2006.11239v2"));
        assert!(is_pdf_url("https://openreview.net/pdf?id=abc123"));
        assert!(!is_pdf_url("https://arxiv.org/abs/2006.11239"));
    }

    #[test]
    fn is_pdf_url_rejects_other_schemes_and_pdf_in_the_query() {
        assert!(!is_pdf_url(
            "chrome-extension://abc/src/pages/reader/index.html?src=x.pdf"
        ));
        assert!(!is_pdf_url("file:///Users/me/paper.pdf"));
        assert!(!is_pdf_url("https://example.com/view?file=paper.pdf"));
        assert!(!is_pdf_url("not a url"));
    }

    #[test]
    fn arxiv_pdf_url_for_new_and_old_ids() {
        assert_eq!(
            arxiv_pdf_url("2406.09246").as_deref(),
            Some("https://arxiv.org/pdf/2406.09246")
        );
        assert_eq!(
            arxiv_pdf_url("hep-th/9901001").as_deref(),
            Some("https://arxiv.org/pdf/hep-th/9901001")
        );
        assert_eq!(arxiv_pdf_url("10.1145/3292500.3330701"), None);
        assert_eq!(arxiv_pdf_url("https://example.com/paper"), None);
        assert_eq!(arxiv_pdf_url(""), None);
    }

    #[test]
    fn reader_pdf_src_reads_encoded_src_and_raw_alike() {
        let url = "https://example.com/paper.pdf?a=1&b=2";
        assert_eq!(
            reader_pdf_src(&format!("?src={}", encode_uri_component(url))),
            url
        );
        assert_eq!(reader_pdf_src(&format!("?raw={url}")), url);
        assert_eq!(reader_pdf_src("?article=x"), "");
    }

    #[test]
    fn reader_page_path_round_trips_urls_with_ampersand_and_hash() {
        let src = "https://example.com/paper.pdf?a=1&b=2#page=3";
        let parsed =
            url::Url::parse(&format!("chrome-extension://abc/{}", reader_page_path(src))).unwrap();
        let got = parsed
            .query_pairs()
            .find(|(k, _)| k == "src")
            .map(|(_, v)| v.into_owned());
        assert_eq!(got.as_deref(), Some(src));
    }

    #[test]
    fn encode_uri_component_matches_javascript() {
        assert_eq!(
            encode_uri_component("a b&c/d?e=f#g~*'()!"),
            "a%20b%26c%2Fd%3Fe%3Df%23g~*'()!"
        );
        assert_eq!(encode_uri_component("π"), "%CF%80");
    }

    const TOPS: [f64; 3] = [0.0, 110.0, 220.0];
    const HEIGHTS: [f64; 3] = [100.0, 100.0, 100.0];

    #[test]
    fn position_from_scroll_finds_the_page_and_offset() {
        assert_eq!(
            position_from_scroll(&TOPS, &HEIGHTS, 0.0),
            PdfPosition {
                page: 1,
                offset: 0.0
            }
        );
        assert_eq!(
            position_from_scroll(&TOPS, &HEIGHTS, 50.0),
            PdfPosition {
                page: 1,
                offset: 0.5
            }
        );
        assert_eq!(
            position_from_scroll(&TOPS, &HEIGHTS, 160.0),
            PdfPosition {
                page: 2,
                offset: 0.5
            }
        );
    }

    #[test]
    fn position_from_scroll_clamps_in_gaps_and_past_the_end() {
        assert_eq!(
            position_from_scroll(&TOPS, &HEIGHTS, 105.0),
            PdfPosition {
                page: 1,
                offset: 1.0
            }
        );
        assert_eq!(
            position_from_scroll(&TOPS, &HEIGHTS, 9999.0),
            PdfPosition {
                page: 3,
                offset: 1.0
            }
        );
        assert_eq!(
            position_from_scroll(&[], &[], 0.0),
            PdfPosition {
                page: 1,
                offset: 0.0
            }
        );
    }

    #[test]
    fn compute_pdf_percent_maps_and_clamps() {
        assert_eq!(compute_pdf_percent(1, 10, 0.0), 0);
        assert_eq!(compute_pdf_percent(6, 10, 0.5), 55);
        assert_eq!(compute_pdf_percent(10, 10, 1.0), 100);
        assert_eq!(compute_pdf_percent(11, 10, 1.0), 100);
        assert_eq!(compute_pdf_percent(1, 0, 0.0), 0);
    }

    fn paper(url: &str, pdf: Option<&str>) -> Paper {
        Paper {
            id: "x".into(),
            title: "T".into(),
            authors: String::new(),
            year: None,
            url: url.into(),
            folder_ids: vec![],
            progress_percent: 0.0,
            left_off: String::new(),
            pdf: pdf.map(|u| crate::types::PdfState {
                url: u.into(),
                page: 1,
                page_count: 10,
                offset: 0.0,
            }),
            added_at: 0,
            updated_at: 0,
            last_read_at: None,
            deleted_at: None,
        }
    }

    #[test]
    fn paper_pdf_source_prefers_the_saved_position_then_pdf_links_then_arxiv() {
        assert_eq!(
            paper_pdf_source(
                "https://arxiv.org/abs/2006.11239",
                Some("https://x.com/a.pdf")
            )
            .as_deref(),
            Some("https://x.com/a.pdf")
        );
        assert_eq!(
            paper_pdf_source("https://arxiv.org/abs/2006.11239", None).as_deref(),
            Some("https://arxiv.org/pdf/2006.11239")
        );
        assert_eq!(
            paper_pdf_source("https://arxiv.org/abs/2006.11239v2", None).as_deref(),
            Some("https://arxiv.org/pdf/2006.11239")
        );
        assert_eq!(
            paper_pdf_source("https://example.com/paper.pdf", None).as_deref(),
            Some("https://example.com/paper.pdf")
        );
        assert_eq!(
            paper_pdf_source("https://dl.acm.org/doi/10.1145/3292500.3330701", None),
            None
        );
        assert_eq!(paper_pdf_source("", None), None);
    }

    #[test]
    fn paper_open_url_goes_to_the_reader_alphaxiv_or_the_link() {
        let base = "chrome-extension://id/";
        assert_eq!(
            paper_open_url(
                &paper("https://arxiv.org/abs/2006.11239v2", None),
                false,
                base
            ),
            format!(
                "{base}{}",
                reader_page_path("https://arxiv.org/pdf/2006.11239")
            )
        );
        assert_eq!(
            paper_open_url(
                &paper("https://arxiv.org/pdf/hep-th/9901001", None),
                false,
                base
            ),
            format!(
                "{base}{}",
                reader_page_path("https://arxiv.org/pdf/hep-th/9901001")
            )
        );
        assert_eq!(
            paper_open_url(
                &paper("https://arxiv.org/abs/2006.11239v2", None),
                true,
                base
            ),
            "https://www.alphaxiv.org/abs/2006.11239"
        );
        assert_eq!(
            paper_open_url(
                &paper("https://dl.acm.org/doi/10.1145/3292500.3330701", None),
                false,
                base
            ),
            "https://dl.acm.org/doi/10.1145/3292500.3330701"
        );
    }

    #[test]
    fn the_arxiv_filter_sends_pdfs_and_leaves_everything_else() {
        let re = regex::Regex::new(ARXIV_PDF_FILTER).unwrap();
        for yes in [
            "https://arxiv.org/pdf/1706.03762",
            "https://arxiv.org/pdf/1706.03762v7",
            "https://www.arxiv.org/pdf/2406.09246.pdf",
            "http://export.arxiv.org/pdf/hep-th/9901001",
        ] {
            assert!(re.is_match(yes), "{yes}");
        }
        for no in [
            "https://arxiv.org/abs/1706.03762",
            "https://arxiv.org/pdf/",
            "https://example.com/paper.pdf",
            "https://notarxiv.org/pdf/1706.03762",
            "https://arxiv.org.evil.com/pdf/1706.03762",
            "file:///Users/me/paper.pdf",
        ] {
            assert!(!re.is_match(no), "{no}");
        }
    }

    #[test]
    fn pdf_rules_redirect_with_the_raw_url_and_bypass_one_url() {
        let r = serde_json::to_value(reader_redirect_rule(
            "chrome-extension://id/src/pages/reader/index.html",
        ))
        .unwrap();
        assert_eq!(
            r["action"]["redirect"]["regexSubstitution"],
            "chrome-extension://id/src/pages/reader/index.html?raw=\\0"
        );
        assert_eq!(r["condition"]["regexFilter"], ARXIV_PDF_FILTER);
        let b = serde_json::to_value(bypass_rule("https://arxiv.org/pdf/1", 2)).unwrap();
        assert_eq!(
            (
                b["id"].as_i64(),
                b["priority"].as_i64(),
                b["action"]["type"].as_str()
            ),
            (Some(3003), Some(2), Some("allow"))
        );
        assert_eq!(b["condition"]["urlFilter"], "|https://arxiv.org/pdf/1|");
        assert!(is_pdf_rule(3000) && is_pdf_rule(3100) && !is_pdf_rule(3101) && !is_pdf_rule(1000));
    }

    #[test]
    fn alphaxiv_url_for_arxiv_only() {
        assert_eq!(
            alphaxiv_url("https://arxiv.org/pdf/2006.11239v3").as_deref(),
            Some("https://www.alphaxiv.org/abs/2006.11239")
        );
        assert_eq!(alphaxiv_url("https://example.com/paper.pdf"), None);
    }
}
