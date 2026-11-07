//! A webpage cut into sections, the way a PDF comes in pages.

use serde::Deserialize;

/// The most text one section carries (one Haiku call narrates one section).
pub const SECTION_MAX_CHARS: usize = 6_000;

/// One block of the page's main content, as `page-text.js` returns it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Block {
    /// 0 for body text, 1-6 for a heading.
    pub level: u8,
    pub text: String,
}

/// The blocks cut into sections: a new one at every h1-h3, and before a
/// section would pass `SECTION_MAX_CHARS`. A block longer than that on its
/// own is cut into pieces of that size.
pub fn sections(blocks: &[Block]) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut cur_len = 0;
    let mut close = |cur: &mut String, cur_len: &mut usize| {
        if !cur.is_empty() {
            out.push(std::mem::take(cur));
        }
        *cur_len = 0;
    };
    for b in blocks {
        let text = b.text.trim();
        if text.is_empty() {
            continue;
        }
        if (1..=3).contains(&b.level) {
            close(&mut cur, &mut cur_len);
        }
        let chars: Vec<char> = text.chars().collect();
        for piece in chars.chunks(SECTION_MAX_CHARS) {
            let sep = usize::from(cur_len > 0);
            if cur_len + sep + piece.len() > SECTION_MAX_CHARS {
                close(&mut cur, &mut cur_len);
            }
            if cur_len > 0 {
                cur.push('\n');
                cur_len += 1;
            }
            cur.extend(piece);
            cur_len += piece.len();
        }
    }
    close(&mut cur, &mut cur_len);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(level: u8, text: &str) -> Block {
        Block {
            level,
            text: text.into(),
        }
    }

    #[test]
    fn cuts_at_top_level_headings_and_keeps_the_heading() {
        let s = sections(&[
            b(1, "Title"),
            b(0, "intro"),
            b(2, "Method"),
            b(0, "body"),
            b(4, "Detail"),
            b(0, "more"),
        ]);
        assert_eq!(s, vec!["Title\nintro", "Method\nbody\nDetail\nmore"]);
    }

    #[test]
    fn bounds_every_section() {
        let para = "x".repeat(1_000);
        let blocks: Vec<Block> = (0..150).map(|_| b(0, &para)).collect();
        let s = sections(&blocks);
        assert!(s.len() >= 25);
        assert!(s.iter().all(|t| t.chars().count() <= SECTION_MAX_CHARS));
        let huge = sections(&[b(0, &"y".repeat(20_000))]);
        assert!(huge.iter().all(|t| t.chars().count() <= SECTION_MAX_CHARS) && huge.len() == 4);
    }

    #[test]
    fn drops_empty_blocks_and_sections() {
        assert!(sections(&[b(2, "  "), b(0, "")]).is_empty());
    }
}
