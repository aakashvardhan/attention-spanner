//! A Pomodoro round: name up to three tasks, focus (distractions blocked),
//! break (the new tab turns to a breathing room), done. One round per start.

use serde::{Deserialize, Serialize};

pub const FOCUS_MS: i64 = 25 * 60 * 1000;
pub const BREAK_MS: i64 = 5 * 60 * 1000;
pub const POMODORO_ALARM: &str = "pomodoro";
pub const MAX_TASKS: usize = 3;

/// Always blocked during focus, on top of the settings blocklist.
pub const DISTRACTIONS: [&str; 10] = [
    "youtube.com",
    "linkedin.com",
    "netflix.com",
    "x.com",
    "twitter.com",
    "instagram.com",
    "facebook.com",
    "reddit.com",
    "tiktok.com",
    "threads.net",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Focus,
    Break,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PomTask {
    pub text: String,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pomodoro {
    pub phase: Phase,
    pub started_at: i64,
    pub ends_at: i64,
    pub tasks: Vec<PomTask>,
}

/// Blank tasks are dropped; None when nothing is left to work on.
pub fn start(tasks: &[String], now: i64) -> Option<Pomodoro> {
    let tasks: Vec<PomTask> = tasks
        .iter()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .take(MAX_TASKS)
        .map(|t| PomTask {
            text: t.into(),
            done: false,
        })
        .collect();
    (!tasks.is_empty()).then_some(Pomodoro {
        phase: Phase::Focus,
        started_at: now,
        ends_at: now + FOCUS_MS,
        tasks,
    })
}

/// The alarm fired: focus turns to break, break ends the round.
pub fn advance(p: Pomodoro, now: i64) -> Option<Pomodoro> {
    match p.phase {
        Phase::Focus => Some(Pomodoro {
            phase: Phase::Break,
            started_at: now,
            ends_at: now + BREAK_MS,
            ..p
        }),
        Phase::Break => None,
    }
}

pub fn is_focus(p: Option<&Pomodoro>) -> bool {
    p.is_some_and(|p| p.phase == Phase::Focus)
}

/// The settings list plus the fixed distractions, no repeats.
pub fn focus_blocklist(settings: &[String]) -> Vec<String> {
    let mut all = settings.to_vec();
    for d in DISTRACTIONS {
        if !all.iter().any(|s| s == d) {
            all.push(d.into());
        }
    }
    all
}

/// "18 min", and seconds only in the last minute.
pub fn left_label(ms: i64) -> String {
    let s = (ms.max(0) + 999) / 1000;
    if s < 60 {
        format!("{s} s")
    } else {
        format!("{} min", (s + 59) / 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_round_is_focus_then_break_then_over() {
        assert_eq!(start(&["  ".into()], 0), None);
        let p = start(
            &["a".into(), "".into(), "b".into(), "c".into(), "d".into()],
            10,
        )
        .unwrap();
        assert_eq!(
            p.tasks.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
            ["a", "b", "c"]
        );
        assert_eq!((p.phase, p.ends_at), (Phase::Focus, 10 + FOCUS_MS));
        assert!(is_focus(Some(&p)));
        let b = advance(p, 100).unwrap();
        assert_eq!((b.phase, b.ends_at), (Phase::Break, 100 + BREAK_MS));
        assert!(!is_focus(Some(&b)));
        assert_eq!(advance(b, 200), None);
    }

    #[test]
    fn blocklist_adds_distractions_once() {
        let l = focus_blocklist(&["netflix.com".into(), "hulu.com".into()]);
        assert_eq!(l.iter().filter(|d| *d == "netflix.com").count(), 1);
        assert!(l.contains(&"youtube.com".into()) && l.contains(&"hulu.com".into()));
    }

    #[test]
    fn labels() {
        assert_eq!(left_label(25 * 60_000), "25 min");
        assert_eq!(left_label(61_000), "2 min");
        assert_eq!(left_label(59_500), "1 min");
        assert_eq!(left_label(58_100), "59 s");
        assert_eq!(left_label(-5), "0 s");
    }
}
