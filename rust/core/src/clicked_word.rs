//! The word under a click, and the text around it for the model.
//!
//! Offsets count `char`s here. JavaScript counts UTF-16 units, so the reader
//! converts the DOM offset before calling in (the same for all BMP text).

use regex::Regex;
use std::sync::LazyLock;

/// Characters each side the model reads.
const CONTEXT_CHARS: usize = 300;
/// Characters each side that key the cache.
const NEAR_CHARS: usize = 30;

static TRAILING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:['’]s)?[-'’]*$").unwrap());

/// Letters and digits, plus hyphens and apostrophes inside a word.
fn is_word_char(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric() || matches!(c, '-' | '\'' | '’')
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClickedWord {
    pub word: String,
    pub context: String,
    pub near: String,
}

/// The word holding the char at `offset`; `None` on a space, punctuation, or a
/// lone character.
pub fn clicked_word(text: &str, offset: usize) -> Option<ClickedWord> {
    let chars: Vec<char> = text.chars().collect();
    if !chars.get(offset).copied().is_some_and(is_word_char) {
        return None;
    }
    let mut start = offset;
    let mut end = offset;
    while start > 0 && is_word_char(chars[start - 1]) {
        start -= 1;
    }
    while end < chars.len() && is_word_char(chars[end]) {
        end += 1;
    }
    let raw: String = chars[start..end].iter().collect();
    let lead = raw
        .chars()
        .take_while(|c| matches!(c, '-' | '\'' | '’'))
        .count();
    let trimmed: String = raw.chars().skip(lead).collect();
    let word = TRAILING.replace(&trimmed, "").to_string();
    if word.chars().count() < 2 || !word.chars().any(char::is_alphabetic) {
        return None;
    }
    let start = start + lead;
    let end = start + word.chars().count();
    let span = |radius: usize| -> String {
        chars[start.saturating_sub(radius)..(end + radius).min(chars.len())]
            .iter()
            .collect::<String>()
            .trim()
            .to_string()
    };
    Some(ClickedWord {
        context: span(CONTEXT_CHARS),
        near: span(NEAR_CHARS),
        word,
    })
}

/// A DOM offset (UTF-16 units) as a char offset into the same text.
pub fn utf16_to_chars(s: &str, units: u32) -> usize {
    let mut seen = 0;
    s.chars()
        .take_while(|c| {
            let fits = seen < units as usize;
            seen += c.len_utf16();
            fits
        })
        .count()
}

/// The DOM offset (UTF-16 units) just past these chars.
pub fn chars_to_utf16(chars: &[char]) -> u32 {
    chars.iter().map(|c| c.len_utf16() as u32).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEXT: &str = "We use temporal-difference (TD) learning, as in Samuel’s checkers player.";

    /// `indexOf` in chars, like the TS tests' `text.indexOf(...)`.
    fn at(needle: &str) -> usize {
        TEXT[..TEXT.find(needle).unwrap()].chars().count()
    }

    #[test]
    fn takes_the_whole_word_hyphens_included() {
        assert_eq!(
            clicked_word(TEXT, at("difference") + 3).unwrap().word,
            "temporal-difference"
        );
        assert_eq!(clicked_word(TEXT, at("TD") + 1).unwrap().word, "TD");
        assert_eq!(
            clicked_word(TEXT, at("learning") + 7).unwrap().word,
            "learning"
        );
    }

    #[test]
    fn drops_a_trailing_apostrophe_s() {
        assert_eq!(clicked_word(TEXT, at("Samuel") + 1).unwrap().word, "Samuel");
    }

    #[test]
    fn ignores_spaces_punctuation_and_lone_characters() {
        assert_eq!(clicked_word(TEXT, at(" use")), None);
        assert_eq!(clicked_word(TEXT, at("(")), None);
        assert_eq!(clicked_word("a b", 0), None);
    }

    #[test]
    fn gives_the_context_and_a_short_cache_key() {
        let long = format!(
            "{}the eligibility trace decays{}",
            "x ".repeat(400),
            " y".repeat(400)
        );
        let hit = clicked_word(&long, long.find("eligibility").unwrap()).unwrap();
        assert!(hit.context.contains("the eligibility trace decays"));
        assert!(hit.context.chars().count() < 700);
        assert!(hit.near.contains("eligibility"));
        assert!(hit.near.len() < long.len());
    }

    #[test]
    fn dom_offsets_count_utf16_units() {
        assert_eq!(utf16_to_chars("abc", 2), 2);
        // 𝑥 is two UTF-16 units and one char
        assert_eq!(utf16_to_chars("𝑥ab", 2), 1);
        assert_eq!(utf16_to_chars("𝑥ab", 3), 2);
        assert_eq!(utf16_to_chars("ab", 9), 2);
        assert_eq!(chars_to_utf16(&['𝑥', 'a']), 3);
    }
}
