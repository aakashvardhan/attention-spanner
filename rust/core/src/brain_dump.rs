//! The brain dump's prompt and reply parsing (src/shared/brainDump.ts).

use crate::todos::{parse_todos, LocalTime};
use regex::Regex;
use std::sync::LazyLock;

pub const MAX_DUMP_CHARS: usize = 4000;
pub const ASK_TIMEOUT_MS: u32 = 60_000;
pub const FAILED_MESSAGE: &str = "Couldn't reach Haiku. Your words are still here.";
pub const SAVE_FAILED_MESSAGE: &str = "Couldn't save your words. Keep this tab open and try again.";
pub const NO_KEY_MESSAGE: &str =
    "Add a Claude key in Settings to get bullets. Your words are still here.";
const MAX_BULLETS: usize = 6;

/// Most to-dos one dump puts on the board.
pub const MAX_TOP_TASKS: usize = 3;

/// One call, two sections: the lighter bullets (no advice, as ever) and, kept
/// apart from them, the few tasks that matter most.
pub const DUMP_SYSTEM: &str = r#"Someone wrote down what is looping in their head. Give it back to them a little lighter, then pick out the few things they most need to do.

Reply in exactly this shape, nothing else: no intro, no closing line.

Lighter:
- 2 to 6 bullets, one per line

Top tasks:
- YYYY-MM-DD HH:MM | task
- | task

Rules for the Lighter bullets:
- Stay faithful to what they wrote. Add no new facts.
- Name feelings as feelings, not verdicts. Shrink a catastrophe to what is actually known.
- No advice, no tasks, no "you should", no next steps.
- No exclamation marks, no cheerleading, no emojis.
- Plain, warm, short sentences.
Example: "nowhere near in career" becomes "- Career feels slow right now. That's a feeling, not a verdict."

Rules for Top tasks:
- At most 3, most urgent or time-bound first. Fewer is fine; leave the section empty if there are none.
- Only tasks they actually mentioned or clearly implied. Add none of your own.
- Start each task with a verb. Keep it under 10 words.
- Write "YYYY-MM-DD HH:MM | task" when a time can be inferred, "| task" when it cannot.
- Resolve "tomorrow", "Friday", "tonight", "after lunch" against the current time you are given. A time with no day means today if it is still ahead, otherwise tomorrow.
- Vague times: morning 09:00, lunch 12:00, afternoon 15:00, evening 18:00, tonight 20:00. Never a time in the past.
- Feelings and worries are not tasks."#;

/// The user turn: the current local time, so relative days resolve.
pub fn dump_prompt(now_label: &str) -> String {
    format!("Current local time: {now_label}. Give this back to me a little lighter, and pick my top tasks.")
}

static TASKS_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[\s#*_]*top tasks[\s*_]*:?[\s*_]*(.*)$").unwrap());

/// The reply's bullets and its top tasks. A reply with no "Top tasks:"
/// section is all bullets (and is what a half-streamed reply looks like).
pub fn parse_dump(reply: &str) -> (Vec<String>, Vec<(String, Option<LocalTime>)>) {
    let mut lines = reply.lines();
    let mut head = String::new();
    let mut tail = String::new();
    for line in lines.by_ref() {
        if let Some(c) = TASKS_HEADER.captures(line) {
            tail.push_str(&c[1]);
            tail.push('\n');
            break;
        }
        head.push_str(line);
        head.push('\n');
    }
    for line in lines {
        tail.push_str(line);
        tail.push('\n');
    }
    let mut tasks = parse_todos(&tail);
    tasks.truncate(MAX_TOP_TASKS);
    (parse_reframe(&head), tasks)
}

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
    fn the_prompt_keeps_bullets_advice_free_and_tasks_apart() {
        assert!(DUMP_SYSTEM.contains("No advice, no tasks"));
        assert!(DUMP_SYSTEM.contains("At most 3"));
        assert!(DUMP_SYSTEM.contains("looping")); // the e2e mock keys on it
        assert!(dump_prompt("Monday 2026-11-02 14:05").contains("2026-11-02 14:05"));
    }

    #[test]
    fn a_reply_splits_into_bullets_and_at_most_three_tasks() {
        let reply = "Lighter:\n- Work feels heavy.\n- That's a feeling.\n\nTop tasks:\n- 2026-11-03 09:00 | Call the dentist\n- | Pay rent\n- | Email Sam\n- | Fourth thing";
        let (bullets, tasks) = parse_dump(reply);
        assert_eq!(bullets, ["Work feels heavy.", "That's a feeling."]);
        assert_eq!(
            tasks,
            vec![
                ("Call the dentist".into(), Some((2026, 11, 3, 9, 0))),
                ("Pay rent".into(), None),
                ("Email Sam".into(), None),
            ]
        );
    }

    #[test]
    fn headers_in_markdown_or_inline_still_split() {
        let (b, t) = parse_dump("**Lighter:**\n- a\n## Top Tasks:\n- | b");
        assert_eq!(
            (b, t),
            (vec!["a".to_string()], vec![("b".to_string(), None)])
        );
        let (b, t) = parse_dump("- a\nTop tasks: - | inline");
        assert_eq!(
            (b, t),
            (vec!["a".to_string()], vec![("inline".to_string(), None)])
        );
    }

    #[test]
    fn no_tasks_section_or_an_empty_one_is_bullets_only() {
        assert_eq!(
            parse_dump("- a\n- b"),
            (vec!["a".into(), "b".into()], vec![])
        );
        assert_eq!(
            parse_dump("Lighter:\n- a\nTop tasks:\n"),
            (vec!["a".into()], vec![])
        );
        // Half-streamed: the header is not complete yet, so nothing leaks into bullets.
        assert_eq!(
            parse_dump("Lighter:\n- a\nTop ta"),
            (vec!["a".into()], vec![])
        );
    }

    #[test]
    fn tasks_without_bullets_parse_but_leave_bullets_empty() {
        let (b, t) = parse_dump("Here you go.\nTop tasks:\n- | Call mum");
        assert!(b.is_empty());
        assert_eq!(t, vec![("Call mum".to_string(), None)]);
    }
}
