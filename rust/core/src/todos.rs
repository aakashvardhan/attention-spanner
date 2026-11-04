//! Brain dump → today's to-do list: reading Haiku's task lines, the board, and
//! the alarm each reminder rides on. Local times stay as plain fields here;
//! the ext crate turns them into timestamps (the browser knows the zone).

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

/// One alarm per to-do, named `todo|<id>`.
pub const TODO_ALARM_PREFIX: &str = "todo|";
const MAX_TODOS: usize = 12;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub text: String,
    /// When to remind, epoch ms; none = sometime today
    #[serde(default)]
    pub due_at: Option<i64>,
    #[serde(default)]
    pub done_at: Option<i64>,
    /// Moved to "In progress"; cleared when moved back to "To do".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    /// Place within its column, set by dragging; ties fall back to the reminder time.
    #[serde(default)]
    pub rank: i32,
}

/// The board column: 0 to do, 1 in progress, 2 done.
pub fn todo_column(t: &Todo) -> usize {
    if t.done_at.is_some() {
        2
    } else if t.started_at.is_some() {
        1
    } else {
        0
    }
}

/// Local wall-clock time: year, month (1-12), day, hour, minute.
pub type LocalTime = (i32, u32, u32, u32, u32);

static LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(?:[-*•]|\d+[.)])\s+(?:(\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2})\s*)?\|?\s*(.+)$")
        .unwrap()
});

/// Tasks from Haiku's reply, each with its time if one was given.
pub fn parse_todos(reply: &str) -> Vec<(String, Option<LocalTime>)> {
    reply
        .lines()
        .filter_map(|line| {
            let c = LINE.captures(line)?;
            let text = c[2].trim().trim_start_matches('|').trim().to_string();
            (!text.is_empty()).then(|| (text, c.get(1).and_then(|t| parse_local(t.as_str()))))
        })
        .take(MAX_TODOS)
        .collect()
}

/// "YYYY-MM-DD HH:MM" or the `datetime-local` input's "YYYY-MM-DDTHH:MM".
pub fn parse_local(s: &str) -> Option<LocalTime> {
    let (date, time) = s.trim().split_once([' ', 'T'])?;
    let mut d = date.split('-').map(str::parse::<u32>);
    let (y, mo, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let (h, mi) = time.split_once(':')?;
    let (h, mi) = (h.parse::<u32>().ok()?, mi.get(..2)?.parse::<u32>().ok()?);
    ((1..=12).contains(&mo) && (1..=31).contains(&day) && h < 24 && mi < 60)
        .then_some((y as i32, mo, day, h, mi))
}

/// The `datetime-local` input's value.
pub fn format_local((y, mo, d, h, mi): LocalTime) -> String {
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}")
}

/// Today's list: open tasks, and ones finished since `today_start` (local midnight).
pub fn keep_today(list: Vec<Todo>, today_start: i64) -> Vec<Todo> {
    list.into_iter()
        .filter(|t| t.done_at.is_none_or(|d| d >= today_start))
        .collect()
}

/// By column, then where it was dragged, then by reminder time, untimed last.
pub fn sort_todos(list: &mut [Todo]) {
    list.sort_by_key(|t| (todo_column(t), t.rank, t.due_at.is_none(), t.due_at));
}

/// A drop: `id` goes to column `col` (0 to do, 1 in progress, 2 done) at
/// `index` among that column's other cards. Every rank is renumbered, so
/// the board shows exactly the order it was dropped in.
pub fn move_todo(list: &mut Vec<Todo>, id: &str, col: usize, index: usize, now: i64) {
    sort_todos(list);
    let Some(pos) = list.iter().position(|t| t.id == id) else {
        return;
    };
    let mut t = list.remove(pos);
    match col {
        0 => (t.started_at, t.done_at) = (None, None),
        1 => (t.started_at, t.done_at) = (t.started_at.or(Some(now)), None),
        _ => t.done_at = t.done_at.or(Some(now)),
    }
    let start = list
        .iter()
        .position(|x| todo_column(x) >= col)
        .unwrap_or(list.len());
    let len = list[start..]
        .iter()
        .take_while(|x| todo_column(x) == col)
        .count();
    list.insert(start + index.min(len), t);
    let mut seen = [0; 3];
    for t in list.iter_mut() {
        let c = todo_column(t);
        t.rank = seen[c];
        seen[c] += 1;
    }
}

/// Reminders still to fire: (alarm name, when).
pub fn alarms_due(list: &[Todo], now: i64) -> Vec<(String, i64)> {
    list.iter()
        .filter(|t| t.done_at.is_none())
        .filter_map(|t| {
            t.due_at
                .filter(|&d| d > now)
                .map(|d| (format!("{TODO_ALARM_PREFIX}{}", t.id), d))
        })
        .collect()
}

/// Open-Meteo's WMO weather code as a word or two.
pub fn sky_label(code: i64) -> &'static str {
    match code {
        0 => "Clear",
        1 | 2 => "Partly cloudy",
        3 => "Overcast",
        45 | 48 => "Fog",
        51..=57 => "Drizzle",
        61..=67 | 80..=82 => "Rain",
        71..=77 | 85 | 86 => "Snow",
        95..=99 => "Thunderstorm",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_timed_and_untimed_tasks_and_drops_prose() {
        let reply = "Here you go:\n- 2026-11-03 09:00 | Call the dentist\n- | Reply to Sam\n* 2026-11-02T18:30 Buy milk\nnot a task";
        assert_eq!(
            parse_todos(reply),
            vec![
                ("Call the dentist".into(), Some((2026, 11, 3, 9, 0))),
                ("Reply to Sam".into(), None),
                ("Buy milk".into(), Some((2026, 11, 2, 18, 30))),
            ]
        );
        assert!(parse_todos("").is_empty());
        assert!(parse_todos("- |  ").is_empty());
    }

    #[test]
    fn local_times_round_trip_and_reject_nonsense() {
        assert_eq!(parse_local("2026-11-02T07:05"), Some((2026, 11, 2, 7, 5)));
        assert_eq!(format_local((2026, 1, 2, 7, 5)), "2026-01-02T07:05");
        assert_eq!(parse_local("2026-13-02 07:05"), None);
        assert_eq!(parse_local("2026-11-02 25:00"), None);
        assert_eq!(parse_local("tomorrow"), None);
    }

    #[test]
    fn today_keeps_open_and_freshly_done_and_sorts_open_timed_first() {
        let t = |id: &str, due: Option<i64>, done: Option<i64>| Todo {
            id: id.into(),
            text: id.into(),
            due_at: due,
            done_at: done,
            started_at: None,
            rank: 0,
        };
        let kept = keep_today(
            vec![
                t("old", None, Some(5)),
                t("new", None, Some(15)),
                t("open", None, None),
            ],
            10,
        );
        assert_eq!(
            kept.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            ["new", "open"]
        );

        let mut list = vec![
            t("done", Some(1), Some(1)),
            t("untimed", None, None),
            t("late", Some(9), None),
            t("soon", Some(2), None),
        ];
        sort_todos(&mut list);
        assert_eq!(
            list.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            ["soon", "late", "untimed", "done"]
        );

        assert_eq!(alarms_due(&list, 5), vec![("todo|late".to_string(), 9)]);
    }

    #[test]
    fn columns_follow_started_then_done() {
        let mut t = Todo::default();
        assert_eq!(todo_column(&t), 0);
        t.started_at = Some(1);
        assert_eq!(todo_column(&t), 1);
        t.done_at = Some(2);
        assert_eq!(todo_column(&t), 2);
    }

    #[test]
    fn a_drop_moves_reorders_and_sets_state() {
        let t = |id: &str| Todo {
            id: id.into(),
            text: id.into(),
            ..Default::default()
        };
        let mut list = vec![t("a"), t("b"), t("c")];
        let ids = |l: &[Todo]| {
            l.iter()
                .map(|t| (t.id.clone(), todo_column(t), t.rank))
                .collect::<Vec<_>>()
        };
        move_todo(&mut list, "c", 0, 0, 5); // reorder within To do
        assert_eq!(
            ids(&list),
            [("c".into(), 0, 0), ("a".into(), 0, 1), ("b".into(), 0, 2)]
        );
        move_todo(&mut list, "a", 1, 9, 5); // to In progress, index clamped
        assert_eq!(
            list.iter().find(|t| t.id == "a").unwrap().started_at,
            Some(5)
        );
        move_todo(&mut list, "b", 2, 0, 6); // straight to Done
        move_todo(&mut list, "a", 2, 0, 7); // above b in Done
        assert_eq!(
            ids(&list),
            [("c".into(), 0, 0), ("a".into(), 2, 0), ("b".into(), 2, 1)]
        );
        move_todo(&mut list, "a", 0, 1, 8); // reopened, back to To do, below c
        let a = list.iter().find(|t| t.id == "a").unwrap();
        assert_eq!(
            (a.started_at, a.done_at, todo_column(a), a.rank),
            (None, None, 0, 1)
        );
        move_todo(&mut list, "zzz", 0, 0, 9); // unknown id: no change
        assert_eq!(list.len(), 3);
    }

    #[test]
    fn names_the_sky() {
        assert_eq!(sky_label(0), "Clear");
        assert_eq!(sky_label(63), "Rain");
        assert_eq!(sky_label(1234), "");
    }
}
