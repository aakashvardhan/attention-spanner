//! A Pomodoro round: name up to three tasks, focus (distractions blocked),
//! break (the new tab turns to a breathing room), done. One round per start.

use crate::todos::Todo;
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
    #[serde(default, rename = "todoId", skip_serializing_if = "Option::is_none")]
    pub todo_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pomodoro {
    pub phase: Phase,
    pub started_at: i64,
    pub ends_at: i64,
    pub tasks: Vec<PomTask>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub study_video: Option<String>,
}

/// Start from existing, unfinished board tasks; repeated or stale ids are ignored.
pub fn start_todos(todos: &mut [Todo], ids: &[String], now: i64) -> Option<Pomodoro> {
    let mut tasks: Vec<PomTask> = Vec::new();
    for id in ids {
        if tasks.len() == MAX_TASKS {
            break;
        }
        if tasks.iter().any(|t| t.todo_id.as_ref() == Some(id)) {
            continue;
        }
        if let Some(t) = todos
            .iter_mut()
            .find(|t| &t.id == id && t.done_at.is_none() && !t.text.trim().is_empty())
        {
            t.started_at.get_or_insert(now);
            tasks.push(PomTask {
                text: t.text.clone(),
                done: false,
                todo_id: Some(id.clone()),
            });
        }
    }
    (!tasks.is_empty()).then_some(Pomodoro {
        phase: Phase::Focus,
        started_at: now,
        ends_at: now + FOCUS_MS,
        tasks,
        study_video: None,
    })
}

/// The board owns linked task text and completion, including edits and deletion.
pub fn sync_tasks(round: &mut Pomodoro, todos: &[Todo]) {
    round.tasks.retain_mut(|task| {
        let Some(id) = &task.todo_id else {
            return true;
        };
        let Some(todo) = todos.iter().find(|t| &t.id == id) else {
            return false;
        };
        task.text = todo.text.clone();
        task.done = todo.done_at.is_some();
        true
    });
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
        let mut todos: Vec<Todo> = ["a", "  ", "b", "c", "d"]
            .iter()
            .map(|t| Todo {
                id: t.to_string(),
                text: t.to_string(),
                ..Default::default()
            })
            .collect();
        let ids: Vec<String> = todos.iter().map(|t| t.id.clone()).collect();
        assert_eq!(start_todos(&mut todos, &ids[1..2], 0), None);
        let p = start_todos(&mut todos, &ids, 10).unwrap();
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
    fn linked_tasks_start_once_and_follow_the_board() {
        let mut todos = vec![
            Todo {
                id: "a".into(),
                text: "Read".into(),
                ..Default::default()
            },
            Todo {
                id: "b".into(),
                text: "Done".into(),
                done_at: Some(1),
                ..Default::default()
            },
        ];
        let mut p = start_todos(
            &mut todos,
            &["missing".into(), "b".into(), "a".into(), "a".into()],
            10,
        )
        .unwrap();
        assert_eq!(p.tasks.len(), 1);
        assert_eq!(p.tasks[0].todo_id.as_deref(), Some("a"));
        assert_eq!(todos[0].started_at, Some(10));
        todos[0].text = "Read section 2".into();
        todos[0].done_at = Some(11);
        sync_tasks(&mut p, &todos);
        assert!(p.tasks[0].done);
        assert_eq!(p.tasks[0].text, "Read section 2");
        todos[0].done_at = None;
        sync_tasks(&mut p, &todos);
        assert!(!p.tasks[0].done);
        sync_tasks(&mut p, &[]);
        assert!(p.tasks.is_empty());
        assert!(start_todos(&mut todos, &["b".into()], 12).is_none());
    }

    #[test]
    fn old_rounds_still_load_and_keep_their_tasks() {
        let mut p: Pomodoro = serde_json::from_str(
            r#"{"phase":"focus","startedAt":1,"endsAt":2,"tasks":[{"text":"Read","done":false}]}"#,
        )
        .unwrap();
        sync_tasks(&mut p, &[]);
        assert_eq!(p.tasks.len(), 1);
        assert_eq!(p.study_video, None);
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
