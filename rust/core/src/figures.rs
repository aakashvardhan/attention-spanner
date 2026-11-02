//! In-text figure and table mentions and their captions
//! (src/pages/reader/figures.ts, the pure half; walking pdf.js text stays in the reader).

use regex::Regex;
use std::sync::LazyLock;

/// "Figure 3", "Fig. 3", "Figs. 3", "Table 2", "Tab. 7".
pub static MENTION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(Fig(?:ure)?s?\.?|Tab(?:le)?s?\.?)\s?(\d{1,3})\b").unwrap()
});
static CAPTION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*(Figure|Fig\.?|Table|Tab\.?)\s?(\d{1,3})\s*([:.|])(.*)$").unwrap()
});

/// `figure:3` / `table:2`: what a mention and a caption agree on.
pub fn mention_key(word: &str, num: &str) -> String {
    let kind = if word.to_ascii_lowercase().starts_with("tab") {
        "table"
    } else {
        "figure"
    };
    format!("{kind}:{}", num.parse::<u32>().unwrap_or(0))
}

/// Every mention in a run of text, as keys, in order.
pub fn mentions(text: &str) -> Vec<String> {
    MENTION_RE
        .captures_iter(text)
        .map(|c| mention_key(&c[1], &c[2]))
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct Caption {
    pub key: String,
    /// It used a colon, the unambiguous form, which beats a full stop for the same figure.
    pub strong: bool,
}

/// The caption a line opens, if any: at the start of the line, then a colon,
/// or a full stop and more text ("…in\nFigure 3." ends a sentence).
pub fn caption_key(line: &str) -> Option<Caption> {
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

    #[test]
    fn finds_every_common_spelling() {
        assert_eq!(
            mentions("see Figure 3, Fig. 4, Figs. 5 and Table 2 (Tab. 7)"),
            ["figure:3", "figure:4", "figure:5", "table:2", "table:7"]
        );
    }

    #[test]
    fn skips_words_that_merely_start_the_same_way() {
        assert!(mentions("Tablet 3 and Figurative 2").is_empty());
    }
}
