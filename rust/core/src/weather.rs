//! The new tab's weather line.

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
    fn names_the_sky() {
        assert_eq!(sky_label(0), "Clear");
        assert_eq!(sky_label(63), "Rain");
        assert_eq!(sky_label(1234), "");
    }
}
