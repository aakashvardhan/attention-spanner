//! In-text figure and table mentions and their captions.

use crate::pdf::PdfPosition;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// "Figure 3", "Fig. 3", "Figs. 3", "Table 2", "Tab. 7".
pub(crate) static MENTION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(Fig(?:ure)?s?\.?|Tab(?:le)?s?\.?)\s?(\d{1,3})\b").unwrap()
});
static CAPTION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*(Figure|Fig\.?|Table|Tab\.?)\s?(\d{1,3})\s*([:.|])(.*)$").unwrap()
});

/// `figure:3` / `table:2`: what a mention and a caption agree on.
pub(crate) fn mention_key(word: &str, num: &str) -> String {
    let kind = if word.to_ascii_lowercase().starts_with("tab") {
        "table"
    } else {
        "figure"
    };
    format!("{kind}:{}", num.parse::<u32>().unwrap_or(0))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Caption {
    pub key: String,
    /// It used a colon, the unambiguous form, which beats a full stop for the same figure.
    pub strong: bool,
}

/// The caption a line opens, if any: at the start of the line, then a colon,
/// or a full stop and more text ("…in\nFigure 3." ends a sentence).
pub(crate) fn caption_key(line: &str) -> Option<Caption> {
    let c = CAPTION_RE.captures(line)?;
    let strong = &c[3] != ".";
    if !strong && c[4].trim().chars().count() < 3 {
        return None;
    }
    Some(Caption {
        key: mention_key(&c[1], &c[2]),
        strong,
    })
}

/// Where each caption is, from every page's text lines: (line text, 0-1 down
/// the page of its first item). A colon caption beats a full-stop one for the
/// same figure; otherwise the first wins.
pub fn captions_from_lines(pages: &[Vec<(String, f64)>]) -> HashMap<String, PdfPosition> {
    let mut found: HashMap<String, (PdfPosition, bool)> = HashMap::new();
    for (i, lines) in pages.iter().enumerate() {
        for (line, y) in lines {
            let Some(c) = caption_key(line) else { continue };
            let pos = PdfPosition {
                page: i as u32 + 1,
                offset: y.clamp(0.0, 1.0),
            };
            match found.get(&c.key) {
                Some((_, strong)) if *strong || !c.strong => {}
                _ => {
                    found.insert(c.key, (pos, c.strong));
                }
            }
        }
    }
    found.into_iter().map(|(k, (p, _))| (k, p)).collect()
}

/// A run of text cut into plain text and mentions of known figures, so the
/// reader can wrap the mentions in place (characters unchanged).
#[derive(Debug, Clone, PartialEq)]
pub enum Segment {
    Text(String),
    Ref { key: String, text: String },
}

pub fn split_mentions(text: &str, known: &HashSet<String>) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut pos = 0;
    for c in MENTION_RE.captures_iter(text) {
        let key = mention_key(&c[1], &c[2]);
        if !known.contains(&key) {
            continue;
        }
        let m = c.get(0).unwrap();
        if m.start() > pos {
            out.push(Segment::Text(text[pos..m.start()].to_string()));
        }
        out.push(Segment::Ref {
            key,
            text: m.as_str().to_string(),
        });
        pos = m.end();
    }
    if pos < text.len() {
        out.push(Segment::Text(text[pos..].to_string()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(key: &str, strong: bool) -> Option<Caption> {
        Some(Caption {
            key: key.into(),
            strong,
        })
    }

    #[test]
    fn colon_captions_are_strong() {
        assert_eq!(
            caption_key("Figure 3: Overview of the model."),
            cap("figure:3", true)
        );
        assert_eq!(
            caption_key("Table 2: Results on GLUE"),
            cap("table:2", true)
        );
        assert_eq!(caption_key("Fig. 4: Ablation"), cap("figure:4", true));
    }

    #[test]
    fn a_full_stop_counts_only_with_caption_text_after_it() {
        assert_eq!(
            caption_key("Figure 5. Attention maps for layer 4"),
            cap("figure:5", false)
        );
        assert_eq!(caption_key("Figure 5."), None);
    }

    #[test]
    fn mentions_that_do_not_open_the_line_are_not_captions() {
        assert_eq!(caption_key("as shown in Figure 3: the loss"), None);
        assert_eq!(caption_key("Figures are shown below"), None);
    }

    /// The keys `split_mentions` wraps in `text` when `known` are the figures.
    fn refs(text: &str, known: &[&str]) -> Vec<String> {
        let known: HashSet<String> = known.iter().map(|k| k.to_string()).collect();
        split_mentions(text, &known)
            .into_iter()
            .filter_map(|s| match s {
                Segment::Ref { key, .. } => Some(key),
                Segment::Text(_) => None,
            })
            .collect()
    }

    #[test]
    fn finds_every_common_spelling() {
        let keys = ["figure:3", "figure:4", "figure:5", "table:2", "table:7"];
        assert_eq!(
            refs("see Figure 3, Fig. 4, Figs. 5 and Table 2 (Tab. 7)", &keys),
            keys
        );
    }

    #[test]
    fn captions_from_lines_prefers_the_colon_form_then_the_first() {
        let pages = vec![
            vec![
                ("as shown in".to_string(), 0.1),
                ("Figure 3. A sentence that ends here".to_string(), 0.2),
            ],
            vec![
                ("Figure 3: The real caption".to_string(), 0.6),
                ("Table 1: Results".to_string(), 1.4),
            ],
            vec![("Table 1: Again".to_string(), 0.3)],
        ];
        let found = captions_from_lines(&pages);
        assert_eq!(
            found["figure:3"],
            PdfPosition {
                page: 2,
                offset: 0.6
            }
        );
        assert_eq!(
            found["table:1"],
            PdfPosition {
                page: 2,
                offset: 1.0
            }
        );
    }

    #[test]
    fn split_mentions_wraps_only_known_figures_keeping_every_character() {
        let known: HashSet<String> = ["figure:3".to_string()].into();
        let text = "see Figure 3, and Table 9 too";
        let parts = split_mentions(text, &known);
        assert_eq!(
            parts,
            vec![
                Segment::Text("see ".into()),
                Segment::Ref {
                    key: "figure:3".into(),
                    text: "Figure 3".into()
                },
                Segment::Text(", and Table 9 too".into()),
            ]
        );
        let joined: String = parts
            .iter()
            .map(|p| match p {
                Segment::Text(t) | Segment::Ref { text: t, .. } => t.as_str(),
            })
            .collect();
        assert_eq!(joined, text);
        assert_eq!(
            split_mentions("nothing here", &known),
            vec![Segment::Text("nothing here".into())]
        );
    }

    #[test]
    fn skips_words_that_merely_start_the_same_way() {
        assert!(refs("Tablet 3 and Figurative 2", &["table:3", "figure:2"]).is_empty());
    }
}
