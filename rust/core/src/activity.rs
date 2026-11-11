//! The heatmap of papers read and reading sessions per local day. Dates come in as `CivilDate`s; see civil_date.rs.

use crate::civil_date::{CivilDate, MONTHS_SHORT};
use crate::types::DayActivity;
use std::collections::{BTreeMap, HashMap, HashSet};

const WEEKS: usize = 53;
/// A year and a margin; older days are pruned on write.
const KEEP_DAYS: i64 = (WEEKS * 7 + 7) as i64;

/// `"YYYY-MM-DD"` → that day. A BTreeMap keeps keys sorted, which is also date order.
pub type ActivityLog = BTreeMap<String, DayActivity>;

#[derive(Debug, Clone, PartialEq)]
pub enum ActivityEvent {
    Paper(String),
    Focus,
    Clocked(u32),
}

/// Fold one event into the log; `None` when nothing changed (so storage is not rewritten).
pub fn add_activity(
    log: &ActivityLog,
    event: &ActivityEvent,
    today: CivilDate,
) -> Option<ActivityLog> {
    let key = today.to_string();
    let mut day = log.get(&key).cloned().unwrap_or_default();
    match event {
        ActivityEvent::Paper(id) if day.papers.contains(id) => return None,
        ActivityEvent::Clocked(0) => return None,
        ActivityEvent::Paper(id) => day.papers.push(id.clone()),
        ActivityEvent::Clocked(minutes) => day.clocked = Some(day.clocked.unwrap_or(0) + minutes),
        ActivityEvent::Focus => day.focus += 1,
    }
    let cutoff = today.add_days(-KEEP_DAYS).to_string();
    let mut next: ActivityLog = log
        .iter()
        .filter(|(k, _)| **k >= cutoff)
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    next.insert(key, day);
    Some(next)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Metric {
    All,
    Papers,
    Focus,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HeatDay {
    pub date: String,
    pub papers: u32,
    pub focus: u32,
    /// `None` after today: the last column is a partial week
    pub level: Option<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HeatModel {
    /// 53 Sunday-first week columns, oldest first
    pub weeks: Vec<Vec<HeatDay>>,
    pub months: Vec<(usize, &'static str)>,
    pub papers: u32,
    pub focus: u32,
}

/// GitHub's quartiles of the busiest day; any activity is at least 1.
pub(crate) fn heat_level(count: u32, max: u32) -> u8 {
    if count == 0 || max == 0 {
        return 0;
    }
    ((f64::from(count) / f64::from(max) * 4.0).ceil() as u8).min(4)
}

fn count_of(papers: u32, focus: u32, metric: Metric) -> u32 {
    match metric {
        Metric::Papers => papers,
        Metric::Focus => focus,
        Metric::All => papers + focus,
    }
}

/// 53 weeks ending with the week holding `today`. A paper's lastReadAt counts
/// too, so the papers row has history from before the log existed.
pub fn build_heat_model(
    log: &ActivityLog,
    papers: &[(String, Option<i64>)],
    metric: Metric,
    today: CivilDate,
    local_date_of: impl Fn(i64) -> CivilDate,
) -> HeatModel {
    let mut read: HashMap<String, HashSet<String>> = log
        .iter()
        .map(|(date, day)| (date.clone(), day.papers.iter().cloned().collect()))
        .collect();
    for (id, last_read) in papers {
        if let Some(at) = last_read {
            read.entry(local_date_of(*at).to_string())
                .or_default()
                .insert(id.clone());
        }
    }

    let start = today.add_days(-i64::from(today.weekday()) - (WEEKS as i64 - 1) * 7);
    let days: Vec<(CivilDate, u32, u32)> = (0..WEEKS as i64 * 7)
        .map(|i| {
            let date = start.add_days(i);
            let key = date.to_string();
            (
                date,
                read.get(&key).map_or(0, |s| s.len() as u32),
                log.get(&key).map_or(0, |d| d.focus),
            )
        })
        .collect();

    let past = days.iter().filter(|(d, ..)| *d <= today);
    let max = past
        .clone()
        .map(|&(_, p, f)| count_of(p, f, metric))
        .max()
        .unwrap_or(0);
    let mut weeks: Vec<Vec<HeatDay>> = Vec::with_capacity(WEEKS);
    let mut months = Vec::new();
    for w in 0..WEEKS {
        let week: Vec<HeatDay> = days[w * 7..w * 7 + 7]
            .iter()
            .map(|&(date, papers, focus)| HeatDay {
                date: date.to_string(),
                papers,
                focus,
                level: (date <= today).then(|| heat_level(count_of(papers, focus, metric), max)),
            })
            .collect();
        let first = days[w * 7].0;
        // Label each month at its first column, skipping a stub at the left edge.
        // A full first week is labelled even when the same month (a year on)
        // starts again at the right edge, as on GitHub's calendar.
        let new_month = if w == 0 {
            first.day <= 7
        } else {
            first.month != days[(w - 1) * 7].0.month
        };
        if new_month {
            months.push((w, MONTHS_SHORT[first.month as usize - 1]));
        }
        weeks.push(week);
    }
    HeatModel {
        weeks,
        months,
        papers: past.clone().map(|&(_, p, _)| p).sum(),
        focus: past.map(|&(_, _, f)| f).sum(),
    }
}

pub fn plural(n: u32, unit: &str) -> String {
    format!("{n} {unit}{}", if n == 1 { "" } else { "s" })
}

/// GitHub's tooltip: "2 papers and 1 focus session on Thursday, October 2".
pub fn heat_tooltip(day: &HeatDay) -> String {
    let when = CivilDate::parse(&day.date)
        .map(CivilDate::long_label)
        .unwrap_or_else(|| day.date.clone());
    let parts: Vec<String> = [(day.papers, "paper"), (day.focus, "focus session")]
        .into_iter()
        .filter(|&(n, _)| n > 0)
        .map(|(n, unit)| plural(n, unit))
        .collect();
    let what = if parts.is_empty() {
        "No reading or focus".to_string()
    } else {
        parts.join(" and ")
    };
    format!("{what} on {when}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODAY: CivilDate = CivilDate {
        year: 2026,
        month: 10,
        day: 2,
    };

    fn day(papers: &[&str], focus: u32) -> DayActivity {
        DayActivity {
            papers: papers.iter().map(|s| s.to_string()).collect(),
            focus,
            clocked: None,
        }
    }

    #[test]
    fn counts_a_paper_once_a_day_and_every_session() {
        let log = add_activity(
            &ActivityLog::new(),
            &ActivityEvent::Paper("a".into()),
            TODAY,
        )
        .unwrap();
        assert_eq!(
            add_activity(&log, &ActivityEvent::Paper("a".into()), TODAY),
            None
        );
        let log = add_activity(&log, &ActivityEvent::Paper("b".into()), TODAY).unwrap();
        let log = add_activity(&log, &ActivityEvent::Focus, TODAY).unwrap();
        let log = add_activity(&log, &ActivityEvent::Focus, TODAY).unwrap();
        assert_eq!(log["2026-10-02"], day(&["a", "b"], 2));
    }

    #[test]
    fn adds_clocked_minutes_and_ignores_an_empty_one() {
        let log = add_activity(&ActivityLog::new(), &ActivityEvent::Clocked(95), TODAY).unwrap();
        let log = add_activity(&log, &ActivityEvent::Clocked(40), TODAY).unwrap();
        assert_eq!(add_activity(&log, &ActivityEvent::Clocked(0), TODAY), None);
        assert_eq!(
            log["2026-10-02"],
            DayActivity {
                papers: vec![],
                focus: 0,
                clocked: Some(135)
            }
        );
    }

    #[test]
    fn prunes_days_older_than_the_calendar_shows() {
        let old: ActivityLog = [("2024-01-01".to_string(), day(&["x"], 1))].into();
        let log = add_activity(&old, &ActivityEvent::Focus, TODAY).unwrap();
        assert_eq!(log.keys().collect::<Vec<_>>(), ["2026-10-02"]);
    }

    fn fixture() -> (ActivityLog, Vec<(String, Option<i64>)>) {
        let log: ActivityLog = [
            ("2026-10-01".to_string(), day(&["a"], 3)),
            ("2026-09-28".to_string(), day(&[], 1)),
        ]
        .into();
        // Timestamps here are just "day numbers"; the closure below maps them.
        let papers = vec![
            ("a".to_string(), Some(1)),
            ("b".to_string(), Some(2)),
            ("c".to_string(), None),
        ];
        (log, papers)
    }
    fn local(at: i64) -> CivilDate {
        if at == 1 {
            CivilDate::new(2026, 10, 1)
        } else {
            TODAY
        }
    }

    #[test]
    fn lays_out_53_sunday_first_weeks_ending_with_today() {
        let (log, papers) = fixture();
        let m = build_heat_model(&log, &papers, Metric::All, TODAY, local);
        assert_eq!(m.weeks.len(), 53);
        assert!(m.weeks.iter().all(|w| w.len() == 7));
        let last = &m.weeks[52];
        assert_eq!(last[0].date, "2026-09-27");
        assert_eq!(last[5].date, "2026-10-02");
        assert_eq!(last[6].level, None);
        assert!(m.weeks[0][0].level.is_some());
    }

    #[test]
    fn merges_last_read_into_the_log_without_double_counting() {
        let (log, papers) = fixture();
        let m = build_heat_model(&log, &papers, Metric::All, TODAY, local);
        assert_eq!((m.papers, m.focus), (2, 4));
        let d = &m.weeks[52][4];
        assert_eq!(
            (d.date.as_str(), d.papers, d.focus, d.level),
            ("2026-10-01", 1, 3, Some(4))
        );
    }

    #[test]
    fn shades_by_the_chosen_metric() {
        let (log, papers) = fixture();
        let p = build_heat_model(&log, &papers, Metric::Papers, TODAY, local);
        assert_eq!(
            (p.weeks[52][1].date.as_str(), p.weeks[52][1].level),
            ("2026-09-28", Some(0))
        );
        assert_eq!(p.weeks[52][5].level, Some(4));
        let f = build_heat_model(&log, &papers, Metric::Focus, TODAY, local);
        assert_eq!(f.weeks[52][1].level, Some(2));
    }

    #[test]
    fn labels_each_month_where_it_starts_like_github() {
        let labels = |today: CivilDate| -> Vec<(usize, &str)> {
            build_heat_model(&ActivityLog::new(), &[], Metric::All, today, local).months
        };
        // The window opens on 2025-09-28, a stub of September: not labelled,
        // so every month shows once.
        let l = labels(TODAY);
        assert_eq!(l[0], (1, "Oct"));
        assert_eq!(l.len(), 12);
        assert_eq!(l.iter().map(|m| m.1).collect::<HashSet<_>>().len(), 12);
        // Opening on 2025-10-05, inside October's first week, that October gets
        // its label, and so does October 2026 in the last column: the same name
        // at both edges, a year apart, as GitHub's calendar does it.
        let l = labels(CivilDate::new(2026, 10, 8));
        assert_eq!(l[0], (0, "Oct"));
        assert_eq!(l.last(), Some(&(52, "Oct")));
        assert_eq!(l.len(), 13);
    }

    #[test]
    fn heat_level_uses_quartiles() {
        assert_eq!([0, 1, 4, 5, 8].map(|n| heat_level(n, 8)), [0, 1, 2, 3, 4]);
        assert_eq!(heat_level(3, 0), 0);
    }

    #[test]
    fn tooltip_reads_like_github() {
        let d = |papers, focus| HeatDay {
            date: "2026-10-01".into(),
            papers,
            focus,
            level: Some(0),
        };
        assert_eq!(
            heat_tooltip(&d(1, 3)),
            "1 paper and 3 focus sessions on Thursday, October 1"
        );
        assert_eq!(
            heat_tooltip(&d(0, 0)),
            "No reading or focus on Thursday, October 1"
        );
    }
}
