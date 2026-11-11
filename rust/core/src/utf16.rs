//! DOM text offsets count UTF-16 units; Rust strings are indexed here by char.

/// A DOM offset (UTF-16 units) as a char index into `s`. An offset inside a
/// surrogate pair counts the char it splits; past the end is the char count.
pub fn utf16_to_chars(s: &str, units: usize) -> usize {
    let mut seen = 0;
    s.chars()
        .take_while(|c| {
            let fits = seen < units;
            seen += c.len_utf16();
            fits
        })
        .count()
}

/// The DOM offset (UTF-16 units) just past the first `chars` chars of `s`.
pub fn chars_to_utf16(s: &str, chars: usize) -> usize {
    s.chars().take(chars).map(char::len_utf16).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dom_offsets_count_utf16_and_chars_count_chars() {
        let s = "a😀b"; // the emoji is 2 UTF-16 units, 1 char
        assert_eq!(utf16_to_chars(s, 0), 0);
        assert_eq!(utf16_to_chars(s, 1), 1);
        assert_eq!(utf16_to_chars(s, 2), 2, "inside the pair");
        assert_eq!(utf16_to_chars(s, 3), 2);
        assert_eq!(utf16_to_chars(s, 99), 3);
        assert_eq!(chars_to_utf16(s, 2), 3);
        assert_eq!(chars_to_utf16(s, 99), 4);
        assert_eq!(utf16_to_chars("abc", 2), 2);
        assert_eq!(utf16_to_chars("𝑥ab", 2), 1);
        assert_eq!(utf16_to_chars("𝑥ab", 3), 2);
        assert_eq!(chars_to_utf16("𝑥a", 2), 3);
    }
}
