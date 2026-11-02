//! The brain dump's prompt and reply parsing (src/shared/brainDump.ts).

use regex::Regex;
use std::sync::LazyLock;

pub const MAX_DUMP_CHARS: usize = 4000;
pub const ASK_TIMEOUT_MS: u32 = 60_000;
pub const FAILED_MESSAGE: &str = "Couldn't reach Haiku. Your words are still here.";
pub const NO_KEY_MESSAGE: &str =
    "Add a Claude key in Settings to get bullets. Your words are still here.";
const MAX_BULLETS: usize = 6;

pub const REFRAME_SYSTEM: &str = r#"Someone wrote down what is looping in their head. Give it back to them a little lighter.

Reply with 2 to 6 bullets, one per line, each starting with "- ". Nothing else: no heading, no intro, no closing line.

Rules:
- Stay faithful to what they wrote. Add no new facts.
- Name feelings as feelings, not verdicts. Shrink a catastrophe to what is actually known.
- No advice, no tasks, no "you should", no next steps.
- No exclamation marks, no cheerleading, no emojis.
- Plain, warm, short sentences.

Example: "nowhere near in career" becomes "- Career feels slow right now. That's a feeling, not a verdict.""#;

static BULLET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:[-*•]|\d+[.)])\s+(.+)").unwrap());

/// Bullet lines from Haiku's reply; a preamble or prose line is dropped.
pub fn parse_reframe(reply: &str) -> Vec<String> {
    reply
        .lines()
        .filter_map(|line| BULLET.captures(line).map(|c| c[1].trim().to_string()))
        .filter(|l| !l.is_empty())
        .take(MAX_BULLETS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_bullets_of_any_mark_and_drops_a_preamble() {
        assert_eq!(parse_reframe("- a\n- b"), ["a", "b"]);
        assert_eq!(
            parse_reframe("Here is a lighter version:\n\n* a\n• b\n1. c\n"),
            ["a", "b", "c"]
        );
        assert!(parse_reframe("just prose with no bullets").is_empty());
        assert_eq!(
            parse_reframe("- 1\n- 2\n- 3\n- 4\n- 5\n- 6\n- 7\n- 8").len(),
            6
        );
    }

    #[test]
    fn the_prompt_asks_for_dash_bullets_only() {
        assert!(REFRAME_SYSTEM.contains("- "));
        assert!(!REFRAME_SYSTEM.contains("Eisenhower"));
    }
}
