//! The reader's anti-drift aids as pure decisions.

const WORDS_PER_MINUTE: f64 = 230.0;

pub fn word_counts(passages: &[&str]) -> Vec<usize> {
    passages
        .iter()
        .map(|p| p.split_whitespace().count())
        .collect()
}

/// Minutes to the end from passage `index`, `fraction` of the way through it.
pub fn minutes_left(counts: Option<&[usize]>, index: usize, fraction: f64) -> Option<u32> {
    let counts = counts?;
    if index >= counts.len() {
        return Some(0);
    }
    let words = counts[index] as f64 * (1.0 - fraction.clamp(0.0, 1.0))
        + counts[index + 1..].iter().sum::<usize>() as f64;
    Some((words / WORDS_PER_MINUTE).ceil() as u32)
}

pub fn time_left_label(minutes: Option<u32>) -> String {
    match minutes {
        None => String::new(),
        Some(0) => "almost done".into(),
        Some(m) => format!("about {m} min left"),
    }
}

/// Reading forward into the next section finishes the previous one; jumps do not.
pub fn crossed_section(prev: i32, next: i32) -> Option<i32> {
    (prev >= 0 && next == prev + 1).then_some(prev)
}

pub fn section_done_label(finished: i32, total: i32) -> String {
    let left = total - finished - 1;
    if left <= 0 {
        "Last section done".into()
    } else {
        format!("Section {} done · {left} left", finished + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts() -> Vec<usize> {
        word_counts(&["one two three four", &"x ".repeat(460), &"y ".repeat(230)])
    }

    #[test]
    fn counts_words_ignoring_extra_whitespace() {
        assert_eq!(counts(), vec![4, 460, 230]);
    }

    #[test]
    fn minutes_left_counts_the_rest_at_230_wpm() {
        let c = counts();
        assert_eq!(minutes_left(Some(&c), 1, 0.0), Some(3));
        assert_eq!(minutes_left(Some(&c), 1, 0.5), Some(2));
        assert_eq!(minutes_left(Some(&c), 2, 1.0), Some(0));
        assert_eq!(minutes_left(None, 0, 0.0), None);
        assert_eq!(minutes_left(Some(&c), 9, 0.0), Some(0));
    }

    #[test]
    fn time_left_label_never_says_0_min() {
        assert_eq!(time_left_label(None), "");
        assert_eq!(time_left_label(Some(0)), "almost done");
        assert_eq!(time_left_label(Some(11)), "about 11 min left");
    }

    #[test]
    fn crossed_section_only_for_reading_forward() {
        assert_eq!(crossed_section(2, 3), Some(2));
        for (a, b) in [(2, 5), (3, 2), (-1, 0), (-1, -1), (2, 2)] {
            assert_eq!(crossed_section(a, b), None, "{a} -> {b}");
        }
    }

    #[test]
    fn section_done_label_counts_what_is_left() {
        assert_eq!(section_done_label(2, 6), "Section 3 done · 3 left");
        assert_eq!(section_done_label(4, 6), "Section 5 done · 1 left");
        assert_eq!(section_done_label(5, 6), "Last section done");
    }
}
