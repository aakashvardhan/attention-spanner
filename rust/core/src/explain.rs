//! Explain-back: the reader says the problem, the trick and why it works in
//! their own words; Haiku grades it against the paper and returns only the gap
//! and where to look, never the answer. Kept per paper, newest last.

use crate::ai::{AiRequest, Task};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The paper text a grade sees; past this, the end of the paper is left out.
const PAPER_TEXT_MAX_CHARS: usize = 150_000;
/// A gap is a pointer, not an essay.
const GAP_MAX_CHARS: usize = 200;
/// Explain-backs kept per paper.
pub const HISTORY_MAX: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Part {
    Problem,
    Trick,
    Why,
}

impl Part {
    pub const ALL: [Part; 3] = [Part::Problem, Part::Trick, Part::Why];
    pub fn label(self) -> &'static str {
        match self {
            Part::Problem => "The problem",
            Part::Trick => "The key trick",
            Part::Why => "Why it works",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Got,
    Partial,
    Missing,
}

/// One part's grade: everything the reader ever sees of it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Grade {
    pub part: Part,
    pub status: Status,
    /// What is missing, never what the answer is; empty when got
    pub gap: String,
    /// The page to look at
    #[serde(default)]
    pub page: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExplainBack {
    pub at: i64,
    pub problem: String,
    pub trick: String,
    pub why: String,
    pub grades: Vec<Grade>,
}

impl ExplainBack {
    /// The parts still open: not got.
    pub fn gaps(&self) -> impl Iterator<Item = &Grade> {
        self.grades.iter().filter(|g| g.status != Status::Got)
    }
}

/// The `explainBacks` storage key: doc key → history, oldest first.
pub type ExplainBacks = HashMap<String, Vec<ExplainBack>>;

pub fn record(all: &mut ExplainBacks, doc_key: &str, entry: ExplainBack) {
    let list = all.entry(doc_key.to_string()).or_default();
    list.push(entry);
    if list.len() > HISTORY_MAX {
        list.drain(..list.len() - HISTORY_MAX);
    }
}

pub fn grade_system() -> String {
    "You check whether a reader understood a research paper. You get the paper's text, marked \
[page N], and the reader's own words for three parts: the problem, the key trick, and why it \
works. Grade each part as got, partial or missing. For partial or missing, name what is missing \
in at most 25 words and the page where the paper covers it. Never state the answer, never \
quote or paraphrase the paper's explanation: say what is missing, not what it is. Reply with \
JSON only, no prose: [{\"part\":\"problem\",\"status\":\"got\",\"gap\":\"\",\"page\":null}, \
{\"part\":\"trick\",...}, {\"part\":\"why\",...}]"
        .into()
}

pub fn grade_request(problem: &str, trick: &str, why: &str, page_texts: &[String]) -> AiRequest {
    let mut text = String::new();
    for (i, page) in page_texts.iter().enumerate() {
        text.push_str(&format!("[page {}]\n{page}\n", i + 1));
    }
    let text: String = text.chars().take(PAPER_TEXT_MAX_CHARS).collect();
    let said = |s: &str| {
        if s.trim().is_empty() {
            "(left blank)".to_string()
        } else {
            s.trim().to_string()
        }
    };
    AiRequest {
        task: Task::Grade,
        system: grade_system(),
        passages: vec![text],
        prompt: format!(
            "The problem: {}\nThe key trick: {}\nWhy it works: {}",
            said(problem),
            said(trick),
            said(why)
        ),
        // Every attempt is graded afresh.
        cache_key: None,
    }
}

/// The model's JSON, read leniently (a code fence or a sentence around it is
/// fine), then held to the rule: one grade per part, a short gap, a real page.
/// Anything else the model wrote is dropped unread. `None` when there is no usable JSON.
pub fn parse_grades(reply: &str, page_count: u32) -> Option<Vec<Grade>> {
    let start = reply.find('[')?;
    let end = reply.rfind(']')?;
    let raw: Vec<serde_json::Value> = serde_json::from_str(reply.get(start..=end)?).ok()?;
    let mut out: Vec<Grade> = Vec::new();
    for v in raw {
        let Ok(mut g) = serde_json::from_value::<Grade>(v) else {
            continue;
        };
        if out.iter().any(|o| o.part == g.part) {
            continue;
        }
        if g.status == Status::Got {
            g.gap.clear();
            g.page = None;
        }
        g.gap = g.gap.trim().chars().take(GAP_MAX_CHARS).collect();
        g.page = g.page.filter(|p| (1..=page_count).contains(p));
        out.push(g);
    }
    out.sort_by_key(|g| Part::ALL.iter().position(|p| *p == g.part));
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_fenced_json_and_keeps_only_gap_and_page() {
        let reply = "Here you go:\n```json\n[{\"part\":\"why\",\"status\":\"missing\",\"gap\":\"You did not say why the bound holds.\",\"page\":4,\"answer\":\"Because of convexity\"},\
{\"part\":\"problem\",\"status\":\"got\",\"gap\":\"ignored\",\"page\":2}]\n```";
        let g = parse_grades(reply, 10).unwrap();
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].part, Part::Problem, "sorted problem, trick, why");
        assert_eq!(
            (g[0].gap.as_str(), g[0].page),
            ("", None),
            "a got part has no gap"
        );
        assert_eq!(g[1].page, Some(4));
        // The stray "answer" field is not part of Grade, so it cannot reach the page.
        assert!(!serde_json::to_string(&g).unwrap().contains("convexity"));
    }

    #[test]
    fn malformed_output_is_none_and_bad_fields_are_dropped() {
        assert_eq!(parse_grades("I think you did well!", 10), None);
        assert_eq!(parse_grades("[not json]", 10), None);
        assert_eq!(
            parse_grades("[{\"part\":\"vibes\",\"status\":\"got\"}]", 10),
            None
        );
        let g = parse_grades(
            &format!(
                "[{{\"part\":\"trick\",\"status\":\"partial\",\"gap\":\"{}\",\"page\":99}},{{\"part\":\"trick\",\"status\":\"got\"}}]",
                "x".repeat(500)
            ),
            10,
        )
        .unwrap();
        assert_eq!(g.len(), 1, "one grade per part");
        assert_eq!(g[0].page, None, "a page past the end is dropped");
        assert_eq!(g[0].gap.chars().count(), GAP_MAX_CHARS);
    }

    #[test]
    fn the_grade_sees_marked_pages_and_says_what_was_left_blank() {
        let r = grade_request("Slow attention", "", "  ", &["a".into(), "b".into()]);
        assert!(r.passages[0].starts_with("[page 1]\na\n[page 2]\nb"));
        assert!(r.prompt.contains("The key trick: (left blank)"));
        assert_eq!(r.cache_key, None);
        assert!(r.system.contains("Never state the answer"));
    }

    #[test]
    fn history_keeps_the_newest_and_gaps_skip_got_parts() {
        let mut all = ExplainBacks::new();
        for at in 0..HISTORY_MAX as i64 + 2 {
            record(
                &mut all,
                "doc",
                ExplainBack {
                    at,
                    problem: String::new(),
                    trick: String::new(),
                    why: String::new(),
                    grades: vec![
                        Grade {
                            part: Part::Problem,
                            status: Status::Got,
                            gap: String::new(),
                            page: None,
                        },
                        Grade {
                            part: Part::Why,
                            status: Status::Partial,
                            gap: "why".into(),
                            page: Some(2),
                        },
                    ],
                },
            );
        }
        let list = &all["doc"];
        assert_eq!(list.len(), HISTORY_MAX);
        assert_eq!(list[0].at, 2);
        assert_eq!(list.last().unwrap().gaps().count(), 1);
    }
}
