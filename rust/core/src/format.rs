//! Short dates for people (src/shared/format.ts).

use crate::civil_date::{CivilDate, MONTHS_SHORT};

/// "Just now", "5m ago", "3h ago", "2d ago", then "Nov 3" (`local` is `at`'s local date).
pub fn relative_date(at: i64, now: i64, local: CivilDate) -> String {
    let mins = (now - at).div_euclid(60_000);
    let hours = (now - at).div_euclid(3_600_000);
    let days = (now - at).div_euclid(86_400_000);
    if mins < 1 {
        "Just now".into()
    } else if mins < 60 {
        format!("{mins}m ago")
    } else if hours < 24 {
        format!("{hours}h ago")
    } else if days < 7 {
        format!("{days}d ago")
    } else {
        format!("{} {}", MONTHS_SHORT[local.month as usize - 1], local.day)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_like_the_typescript() {
        let now = 10_000_000_000;
        let d = CivilDate::new(2026, 11, 3);
        assert_eq!(relative_date(now - 30_000, now, d), "Just now");
        assert_eq!(relative_date(now - 5 * 60_000, now, d), "5m ago");
        assert_eq!(relative_date(now - 3 * 3_600_000, now, d), "3h ago");
        assert_eq!(relative_date(now - 2 * 86_400_000, now, d), "2d ago");
        assert_eq!(relative_date(now - 9 * 86_400_000, now, d), "Nov 3");
        // A clock that ran backwards still reads as now, not "-1m ago".
        assert_eq!(relative_date(now + 60_000, now, d), "Just now");
    }
}
