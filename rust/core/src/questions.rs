//! When the reader asks, and what it asks about: one question at the end of a
//! section, or after a stall (no scroll for a while). Haiku writes it from the
//! section's own text; it asks, it never explains.

use crate::ai::{AiRequest, Task, MATH_RULE};
use crate::outline::FlatOutlineItem;

/// Past this much text a question is about the start of the section only.
const SECTION_TEXT_MAX_CHARS: usize = 12_000;

/// What a question is about: a section of the outline, or a page when the PDF has none.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Spot {
    Section(usize),
    Page(u32),
}

impl Spot {
    pub fn key(&self) -> String {
        match self {
            Spot::Section(i) => format!("s{i}"),
            Spot::Page(p) => format!("p{p}"),
        }
    }
}

/// The section (or page) the reader is in.
pub fn spot_at(sections: &[FlatOutlineItem], section: Option<usize>, page: u32) -> Spot {
    match section {
        Some(i) if !sections.is_empty() => Spot::Section(i),
        _ => Spot::Page(page),
    }
}

/// The pages a spot covers: a section runs from its heading's page to the
/// next heading's page (the next section usually starts mid-page).
pub fn spot_pages(sections: &[FlatOutlineItem], spot: &Spot, page_count: u32) -> (u32, u32) {
    match spot {
        Spot::Page(p) => (*p, *p),
        Spot::Section(i) => {
            let start = sections.get(*i).map_or(1, |s| s.page);
            let end = sections
                .get(i + 1)
                .map_or(page_count, |n| n.page)
                .max(start);
            (start, end.min(page_count.max(start)))
        }
    }
}

/// The section just finished: the reader moved on into the next one. Moving
/// back is not finishing, and a jump over sections (the outline, a restored
/// position) did not read the one it left.
pub fn section_finished(before: Option<usize>, now: Option<usize>) -> Option<usize> {
    match (before, now) {
        (Some(b), Some(n)) if n == b + 1 => Some(b),
        _ => None,
    }
}

pub fn question_system() -> String {
    format!(
        "You help someone read a research paper by asking, never telling. You get the text of one \
section. Ask exactly one short question (at most 30 words) that makes the reader put the \
section's key idea in their own words: what problem it solves, what the trick is, or why it \
works. Never answer it, never hint at the answer, never summarise. No preamble, no emoji: \
reply with the question alone.{MATH_RULE}"
    )
}

/// One question about a spot, cached per paper and spot. `pages` are the spot's page texts.
pub fn question_request(doc_key: &str, spot: &Spot, title: &str, pages: &[String]) -> AiRequest {
    let text: String = pages
        .join("\n")
        .chars()
        .take(SECTION_TEXT_MAX_CHARS)
        .collect();
    let what = if title.is_empty() {
        "this part of the paper".to_string()
    } else {
        format!("the section \"{title}\"")
    };
    AiRequest {
        task: Task::Question,
        system: question_system(),
        passages: vec![text],
        prompt: format!("The reader has just read {what}. Ask your one question."),
        cache_key: Some(format!("{doc_key}:{}", spot.key())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sections() -> Vec<FlatOutlineItem> {
        [("Intro", 1), ("Method", 3), ("Results", 7)]
            .iter()
            .map(|(t, p)| FlatOutlineItem {
                title: t.to_string(),
                level: 0,
                page: *p,
            })
            .collect()
    }

    #[test]
    fn a_section_runs_to_the_next_heading_page_and_the_last_to_the_end() {
        let s = sections();
        assert_eq!(spot_pages(&s, &Spot::Section(0), 10), (1, 3));
        assert_eq!(spot_pages(&s, &Spot::Section(2), 10), (7, 10));
        assert_eq!(spot_pages(&s, &Spot::Page(4), 10), (4, 4));
    }

    #[test]
    fn without_an_outline_the_spot_is_the_page() {
        assert_eq!(spot_at(&[], None, 5), Spot::Page(5));
        assert_eq!(spot_at(&sections(), Some(1), 5), Spot::Section(1));
        assert_eq!(spot_at(&sections(), None, 1), Spot::Page(1));
    }

    #[test]
    fn only_moving_forward_finishes_a_section() {
        assert_eq!(section_finished(Some(0), Some(1)), Some(0));
        assert_eq!(section_finished(Some(2), Some(1)), None);
        assert_eq!(
            section_finished(Some(0), Some(3)),
            None,
            "a jump is not reading"
        );
        assert_eq!(section_finished(Some(1), Some(1)), None);
        assert_eq!(section_finished(None, Some(0)), None);
    }

    #[test]
    fn the_question_is_cached_per_spot_and_never_explains() {
        let a = question_request("doc", &Spot::Section(1), "Method", &["We use TD.".into()]);
        let b = question_request("doc", &Spot::Page(1), "", &["x".into()]);
        assert_ne!(a.cache_key, b.cache_key);
        assert_eq!(a.task, Task::Question);
        assert!(a.prompt.contains("\"Method\""));
        assert!(a.system.contains("never telling"));
        let long = question_request("doc", &Spot::Page(1), "", &["é".repeat(20_000)]);
        assert_eq!(long.passages[0].chars().count(), SECTION_TEXT_MAX_CHARS);
    }
}
