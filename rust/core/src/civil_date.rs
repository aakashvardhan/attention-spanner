//! A calendar date with no time and no time zone: what "today" means to the
//! person reading. The browser knows the local zone; it hands in today's date
//! and a timestamp → date function, and everything here is arithmetic.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CivilDate {
    pub year: i32,
    /// 1-12
    pub month: u32,
    /// 1-31
    pub day: u32,
}

pub const MONTHS_SHORT: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MONTHS_LONG: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

impl CivilDate {
    pub fn new(year: i32, month: u32, day: u32) -> Self {
        CivilDate { year, month, day }
    }

    /// Days since 1970-01-01 (Howard Hinnant's `days_from_civil`, exact for
    /// the proleptic Gregorian calendar).
    pub fn to_days(self) -> i64 {
        let y = i64::from(self.year) - i64::from(self.month <= 2);
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let m = i64::from(self.month);
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(self.day) - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    }

    /// The inverse of `to_days`.
    pub fn from_days(days: i64) -> Self {
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        let year = (yoe + era * 400 + i64::from(month <= 2)) as i32;
        CivilDate { year, month, day }
    }

    pub fn add_days(self, n: i64) -> Self {
        Self::from_days(self.to_days() + n)
    }

    /// 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday).
    pub fn weekday(self) -> u32 {
        (self.to_days() + 4).rem_euclid(7) as u32
    }

    /// `YYYY-MM-DD`, the activity log's key.
    pub fn parse(s: &str) -> Option<Self> {
        let mut parts = s.splitn(3, '-');
        let year = parts.next()?.parse().ok()?;
        let month = parts.next()?.parse().ok()?;
        let day = parts.next()?.parse().ok()?;
        ((1..=12).contains(&month) && (1..=31).contains(&day)).then_some(CivilDate {
            year,
            month,
            day,
        })
    }

    /// "Thursday, October 1", as `toLocaleDateString('en-US', …)` writes it.
    pub fn long_label(self) -> String {
        format!(
            "{}, {} {}",
            WEEKDAYS[self.weekday() as usize],
            MONTHS_LONG[self.month as usize - 1],
            self.day
        )
    }
}

/// `Display` gives `to_string()` and `format!("{date}")` for free.
impl fmt::Display for CivilDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_days_across_leap_years_and_centuries() {
        assert_eq!(CivilDate::new(1970, 1, 1).to_days(), 0);
        for (y, m, d) in [
            (2000, 2, 29),
            (1900, 3, 1),
            (2026, 10, 2),
            (2024, 12, 31),
            (1969, 12, 31),
        ] {
            let date = CivilDate::new(y, m, d);
            assert_eq!(CivilDate::from_days(date.to_days()), date);
        }
        assert_eq!(
            CivilDate::new(2026, 2, 28).add_days(1),
            CivilDate::new(2026, 3, 1)
        );
        assert_eq!(
            CivilDate::new(2024, 2, 28).add_days(1),
            CivilDate::new(2024, 2, 29)
        );
        assert_eq!(
            CivilDate::new(2026, 1, 1).add_days(-1),
            CivilDate::new(2025, 12, 31)
        );
    }

    #[test]
    fn knows_its_weekday_and_writes_its_key() {
        assert_eq!(CivilDate::new(2026, 10, 2).weekday(), 5); // a Friday
        assert_eq!(CivilDate::new(2026, 10, 2).to_string(), "2026-10-02");
        assert_eq!(
            CivilDate::parse("2026-10-02"),
            Some(CivilDate::new(2026, 10, 2))
        );
        assert_eq!(CivilDate::parse("2026-13-02"), None);
        assert_eq!(
            CivilDate::new(2026, 10, 1).long_label(),
            "Thursday, October 1"
        );
    }
}
