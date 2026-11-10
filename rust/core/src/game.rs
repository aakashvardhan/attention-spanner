//! The game: XP, a level, a streak and today's three quests. All of it is
//! worked out from what the extension already stores (the activity log, the
//! explain-backs, the lexicon, the shelf, the to-dos), so nothing here is
//! saved and nothing can drift or be migrated.
// ponytail: the activity log keeps a year, so minutes older than that stop
// counting and a level can slip. Store a running total if it must never drop.

use crate::activity::ActivityLog;
use crate::annotations::annotation_doc_key;
use crate::civil_date::CivilDate;
use crate::explain::{ExplainBacks, Status};
use crate::lexicon::Lexicon;
use crate::todos::Todo;
use crate::types::Paper;

/// Minutes that make a day count: the README's "twenty minutes with a paper".
pub const DAY_GOAL: u32 = 20;
/// Terms kept from one paper for its third mark.
pub const TERMS_GOAL: usize = 3;

const XP_MINUTE: u32 = 1;
const XP_DAY_GOAL: u32 = 20;
const XP_EXPLAIN: u32 = 30;
/// Per part the latest explain-back got right.
const XP_PART_GOT: u32 = 20;
const XP_TERM_GUESSED: u32 = 5;
const XP_TERM: u32 = 2;
const XP_PAPER: u32 = 100;

#[derive(Debug, Clone, PartialEq)]
pub struct Quest {
    pub label: &'static str,
    /// "12 of 20 min", or "Done"
    pub detail: String,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Game {
    pub xp: u32,
    /// From 1
    pub level: u32,
    pub title: &'static str,
    /// XP earned inside this level, and how much the level takes
    pub into: u32,
    pub span: u32,
    /// Days in a row that met DAY_GOAL; one missed day a week is forgiven
    pub streak: u32,
    pub minutes_today: u32,
    pub quests: Vec<Quest>,
}

impl Game {
    /// "Day 6 of your streak. 8 minutes to go today."
    pub fn nudge(&self) -> String {
        let left = DAY_GOAL.saturating_sub(self.minutes_today);
        let streak = match self.streak {
            0 => "No streak yet".to_string(),
            n => format!("Day {n} of your streak"),
        };
        match left {
            0 => format!("{streak}. Today already counts."),
            1 => format!("{streak}. 1 minute to go today."),
            n => format!("{streak}. {n} minutes to go today."),
        }
    }
}

impl Game {
    pub fn cleared(&self) -> bool {
        !self.quests.is_empty() && self.quests.iter().all(|q| q.done)
    }
}

/// What to say when the game moves from `prev` to `next`: a level, a cleared
/// day, the day's goal, or the XP earned. A minute passing says nothing.
pub fn gain(prev: &Game, next: &Game) -> Option<String> {
    if next.level > prev.level {
        return Some(format!("Level {} · {}", next.level, next.title));
    }
    if next.cleared() && !prev.cleared() {
        return Some("All three quests done today".into());
    }
    let delta = next.xp.saturating_sub(prev.xp);
    if prev.minutes_today < DAY_GOAL && next.minutes_today >= DAY_GOAL {
        return Some(format!(
            "+{delta} XP · today counts, day {} of your streak",
            next.streak
        ));
    }
    (delta > 1).then(|| format!("+{delta} XP"))
}

/// Level n takes n × 100 XP: (level, XP into it, XP it takes).
pub fn level_of(xp: u32) -> (u32, u32, u32) {
    let (mut level, mut floor) = (1, 0);
    while xp >= floor + level * 100 {
        floor += level * 100;
        level += 1;
    }
    (level, xp - floor, level * 100)
}

pub fn title_of(level: u32) -> &'static str {
    match level {
        0..=1 => "Skimmer",
        2..=3 => "Reader",
        4..=6 => "Close reader",
        7..=9 => "Annotator",
        10..=14 => "Reviewer",
        15..=19 => "Scholar",
        _ => "Professor",
    }
}

/// Days in a row that met the goal, ending today or (while today is still
/// open) yesterday. A single missed day between two met days is forgiven, at
/// most once in seven days; it bridges the streak without adding to it.
pub fn streak(log: &ActivityLog, today: CivilDate, minutes_today: u32) -> u32 {
    let met = |d: CivilDate| {
        if d == today {
            minutes_today >= DAY_GOAL
        } else {
            log.get(&d.to_string())
                .is_some_and(|a| a.clocked.unwrap_or(0) >= DAY_GOAL)
        }
    };
    let mut day = if met(today) {
        today
    } else {
        today.add_days(-1)
    };
    let (mut n, mut since_rest) = (0, 6);
    loop {
        if met(day) {
            n += 1;
            since_rest += 1;
        } else if since_rest >= 6 && met(day.add_days(-1)) {
            since_rest = 0;
        } else {
            return n;
        }
        day = day.add_days(-1);
    }
}

/// A paper's three marks: read, explained, and enough terms kept.
pub fn marks(paper: &Paper, explains: &ExplainBacks, lexicon: &Lexicon) -> (bool, bool, usize) {
    let key = annotation_doc_key(&paper.url);
    let pdf_key = paper.pdf.as_ref().map(|p| annotation_doc_key(&p.url));
    let terms = lexicon
        .terms
        .iter()
        .flat_map(|t| &t.sources)
        .filter(|s| s.doc_key == key || Some(&s.doc_key) == pdf_key.as_ref())
        .count();
    (
        paper.progress_percent >= 90.0,
        explains.get(&key).is_some_and(|l| !l.is_empty()),
        terms,
    )
}

/// "Read · Explained · 1 of 3 terms", the marks still open said plainly.
pub fn marks_label((read, explained, terms): (bool, bool, usize)) -> String {
    [
        if read { "Read" } else { "Not read yet" }.to_string(),
        if explained {
            "Explained"
        } else {
            "Not explained yet"
        }
        .to_string(),
        if terms >= TERMS_GOAL {
            "Terms kept".to_string()
        } else {
            format!("{terms} of {TERMS_GOAL} terms")
        },
    ]
    .join(" · ")
}

/// `live_minutes`: the session or round running right now, not yet in the log.
#[allow(clippy::too_many_arguments)]
pub fn build(
    log: &ActivityLog,
    explains: &ExplainBacks,
    lexicon: &Lexicon,
    papers: &[Paper],
    todos: &[Todo],
    live_minutes: u32,
    today: CivilDate,
    local_date_of: impl Fn(i64) -> CivilDate,
) -> Game {
    let key = today.to_string();
    let minutes_today = log.get(&key).and_then(|d| d.clocked).unwrap_or(0) + live_minutes;
    let is_today = |at: i64| local_date_of(at) == today;

    let past = log.iter().filter(|(k, _)| **k != key);
    let minutes: u32 = past.clone().filter_map(|(_, d)| d.clocked).sum::<u32>() + minutes_today;
    let goal_days = past
        .filter(|(_, d)| d.clocked.unwrap_or(0) >= DAY_GOAL)
        .count() as u32
        + u32::from(minutes_today >= DAY_GOAL);
    let explained: u32 = explains
        .values()
        .map(|list| {
            let got = list.last().map_or(0, |e| {
                e.grades.iter().filter(|g| g.status == Status::Got).count()
            });
            list.len() as u32 * XP_EXPLAIN + got as u32 * XP_PART_GOT
        })
        .sum();
    let sources = || lexicon.terms.iter().flat_map(|t| &t.sources);
    let terms: u32 = sources()
        .map(|s| {
            if s.guess.trim().is_empty() {
                XP_TERM
            } else {
                XP_TERM_GUESSED
            }
        })
        .sum();
    let finished = papers
        .iter()
        .filter(|p| p.deleted_at.is_none() && p.progress_percent >= 100.0)
        .count() as u32;

    let xp =
        minutes * XP_MINUTE + goal_days * XP_DAY_GOAL + explained + terms + finished * XP_PAPER;
    let (level, into, span) = level_of(xp);

    let thought = explains.values().flatten().any(|e| is_today(e.at))
        || sources().any(|s| is_today(s.added_at));
    let did = todos.iter().any(|t| t.done_at.is_some_and(is_today));
    let quest = |label, done: bool, open: String| Quest {
        label,
        detail: if done { "Done".into() } else { open },
        done,
    };
    Game {
        xp,
        level,
        title: title_of(level),
        into,
        span,
        streak: streak(log, today, minutes_today),
        minutes_today,
        quests: vec![
            quest(
                "Read or focus for 20 minutes",
                minutes_today >= DAY_GOAL,
                format!("{minutes_today} of {DAY_GOAL} min"),
            ),
            quest(
                "Explain a paper back, or keep a term",
                thought,
                "Not yet".into(),
            ),
            quest("Finish a to-do", did, "Not yet".into()),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::explain::{ExplainBack, Grade, Part};
    use crate::lexicon::{Source, Term};
    use crate::types::DayActivity;

    const TODAY: CivilDate = CivilDate {
        year: 2026,
        month: 11,
        day: 9,
    };

    /// `days[i]` is the minutes clocked i days before today.
    fn log(days: &[u32]) -> ActivityLog {
        days.iter()
            .enumerate()
            .filter(|(_, &m)| m > 0)
            .map(|(i, &m)| {
                (
                    TODAY.add_days(-(i as i64)).to_string(),
                    DayActivity {
                        clocked: Some(m),
                        ..Default::default()
                    },
                )
            })
            .collect()
    }

    #[test]
    fn levels_take_a_hundred_more_each() {
        assert_eq!(level_of(0), (1, 0, 100));
        assert_eq!(level_of(99), (1, 99, 100));
        assert_eq!(level_of(100), (2, 0, 200));
        assert_eq!(level_of(650), (4, 50, 400));
    }

    #[test]
    fn a_streak_survives_an_open_today_and_one_missed_day_a_week() {
        let s = |days: &[u32]| streak(&log(days), TODAY, days[0]);
        assert_eq!(s(&[0]), 0);
        assert_eq!(s(&[25]), 1);
        // Today has not counted yet: yesterday's streak still stands.
        assert_eq!(s(&[5, 20, 30]), 2);
        // One gap is bridged and not counted; under the goal is a gap.
        assert_eq!(s(&[20, 19, 20, 20]), 3);
        // Two missed days in a row end it, and so does a second gap that week.
        assert_eq!(s(&[20, 0, 0, 20]), 1);
        assert_eq!(s(&[20, 0, 20, 0, 20]), 2);
        // A gap is never forgiven at the far end of the streak.
        assert_eq!(s(&[20, 20, 0]), 2);
    }

    #[test]
    fn xp_adds_up_what_is_stored_and_quests_follow_today() {
        let at = 1_000; // "today" for the closure below; anything else is older
        let local = |t: i64| if t == at { TODAY } else { TODAY.add_days(-3) };
        let explains: ExplainBacks = [(
            "k".to_string(),
            vec![ExplainBack {
                at: 1,
                problem: String::new(),
                trick: String::new(),
                why: String::new(),
                grades: vec![Grade {
                    part: Part::Problem,
                    status: Status::Got,
                    gap: String::new(),
                    page: None,
                }],
            }],
        )]
        .into();
        let lexicon = Lexicon {
            terms: vec![Term {
                sources: vec![Source {
                    guess: "a guess".into(),
                    added_at: at,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let papers = [Paper {
            progress_percent: 100.0,
            ..Default::default()
        }];
        let todos = [Todo {
            done_at: Some(1),
            ..Default::default()
        }];
        // 12 today + 3 live, 30 two days ago (a goal day).
        let g = build(
            &log(&[12, 0, 30]),
            &explains,
            &lexicon,
            &papers,
            &todos,
            3,
            TODAY,
            local,
        );
        assert_eq!(g.minutes_today, 15);
        assert_eq!(g.xp, 45 + 20 + (30 + 20) + 5 + 100);
        assert_eq!((g.level, g.title), (2, "Reader"));
        assert_eq!(
            g.quests.iter().map(|q| q.done).collect::<Vec<_>>(),
            [false, true, false]
        );
        assert_eq!(g.quests[0].detail, "15 of 20 min");
        // Yesterday was missed, forgiven: the day before still holds a streak of one.
        assert_eq!(g.nudge(), "Day 1 of your streak. 5 minutes to go today.");
    }

    #[test]
    fn a_gain_names_the_biggest_thing_that_happened() {
        let g = |xp: u32, minutes_today: u32, done: [bool; 3]| {
            let (level, into, span) = level_of(xp);
            Game {
                xp,
                level,
                title: title_of(level),
                into,
                span,
                streak: 4,
                minutes_today,
                quests: done
                    .map(|done| Quest {
                        label: "",
                        detail: String::new(),
                        done,
                    })
                    .to_vec(),
            }
        };
        let open = [false; 3];
        assert_eq!(gain(&g(10, 5, open), &g(10, 5, open)), None);
        assert_eq!(gain(&g(10, 5, open), &g(11, 6, open)), None);
        assert_eq!(
            gain(&g(10, 5, open), &g(40, 5, open)).as_deref(),
            Some("+30 XP")
        );
        assert_eq!(
            gain(&g(19, 19, open), &g(40, 20, open)).as_deref(),
            Some("+21 XP · today counts, day 4 of your streak")
        );
        assert_eq!(
            gain(&g(90, 5, open), &g(120, 5, open)).as_deref(),
            Some("Level 2 · Reader")
        );
        assert_eq!(
            gain(&g(10, 5, [true, true, false]), &g(10, 5, [true; 3])).as_deref(),
            Some("All three quests done today")
        );
        // Before storage has answered there are no quests: nothing is "cleared".
        assert!(!Game::default().cleared());
    }

    #[test]
    fn a_paper_earns_its_marks_one_by_one() {
        let paper = Paper {
            url: "https://arxiv.org/abs/2006.11239".into(),
            progress_percent: 92.0,
            ..Default::default()
        };
        let m = marks(&paper, &ExplainBacks::new(), &Lexicon::default());
        assert_eq!(m, (true, false, 0));
        assert_eq!(marks_label(m), "Read · Not explained yet · 0 of 3 terms");
    }
}
