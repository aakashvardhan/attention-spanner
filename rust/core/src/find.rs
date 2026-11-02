//! Find in the paper (src/pages/reader/components/PdfFindPanel.tsx): every
//! page containing the query, with an excerpt around the first hit.

pub const MAX_MATCHES: usize = 50;

#[derive(Debug, Clone, PartialEq)]
pub struct FindMatch {
    /// 1-based
    pub page: usize,
    pub excerpt: String,
}

/// Case-insensitive; 60 chars before and 100 after the hit, whitespace
/// collapsed, ellipses where the page goes on. At most 50 pages.
pub fn find_matches(pages: &[String], query: &str) -> Vec<FindMatch> {
    let needle: Vec<char> = query.trim().to_lowercase().chars().collect();
    if needle.is_empty() {
        return vec![];
    }
    pages
        .iter()
        .enumerate()
        .filter_map(|(i, text)| {
            let chars: Vec<char> = text.chars().collect();
            let lower: Vec<char> = text.to_lowercase().chars().collect();
            // Lowercasing can change the char count (rare scripts); only compare when it doesn't.
            if lower.len() != chars.len() {
                return None;
            }
            let at = lower
                .windows(needle.len())
                .position(|w| w == needle.as_slice())?;
            let start = at.saturating_sub(60);
            let end = (at + needle.len() + 100).min(chars.len());
            let body: String = chars[start..end]
                .iter()
                .collect::<String>()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            let lead = if start > 0 { "…" } else { "" };
            let tail = if end < chars.len() { "…" } else { "" };
            Some(FindMatch {
                page: i + 1,
                excerpt: format!("{lead}{body}{tail}"),
            })
        })
        .take(MAX_MATCHES)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pages() -> Vec<String> {
        vec![
            "Intro text.".into(),
            format!(
                "{}The Attention   mechanism\nworks.{}",
                "x".repeat(80),
                "y".repeat(200)
            ),
            "no hit".into(),
            "ATTENTION here".into(),
        ]
    }

    #[test]
    fn finds_every_page_case_insensitively_with_an_excerpt() {
        let m = find_matches(&pages(), "  attention ");
        assert_eq!(m.iter().map(|m| m.page).collect::<Vec<_>>(), [2, 4]);
        assert!(m[0].excerpt.starts_with('…') && m[0].excerpt.ends_with('…'));
        assert!(m[0].excerpt.contains("The Attention mechanism works."));
        assert_eq!(m[1].excerpt, "ATTENTION here");
    }

    #[test]
    fn an_empty_query_finds_nothing_and_results_cap_at_50() {
        assert!(find_matches(&pages(), "   ").is_empty());
        let many: Vec<String> = (0..80).map(|_| "word".to_string()).collect();
        assert_eq!(find_matches(&many, "word").len(), MAX_MATCHES);
    }
}
