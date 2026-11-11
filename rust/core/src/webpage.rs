//! A webpage cut into sections, the way a PDF comes in pages.

use serde::Deserialize;

/// The most text one section carries (one Haiku call narrates one section).
pub(crate) const SECTION_MAX_CHARS: usize = 6_000;

/// One block of the page's main content, as `page-text.js` returns it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Block {
    /// 0 for body text, 1-6 for a heading.
    pub level: u8,
    pub text: String,
}

/// The blocks cut into sections: a new one at every h1-h3 that follows body
/// text (headings in a row, like a blog's date over its title, stay with what
/// they head), and before a section would pass `SECTION_MAX_CHARS`. A block
/// longer than that on its own is cut into pieces of that size.
pub fn sections(blocks: &[Block]) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut cur_len = 0;
    // The last block was body text, not a top-level heading.
    let mut after_body = false;
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
        let top = (1..=3).contains(&b.level);
        if top && after_body {
            close(&mut cur, &mut cur_len);
        }
        after_body = !top;
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
    fn headings_with_nothing_under_them_join_the_next_section() {
        // A blog's date header straight before the post title (Blogger).
        let s = sections(&[
            b(2, "Thursday, December 15, 2022"),
            b(3, "The $8 linux computer"),
            b(0, "Yes, you read that right."),
            b(2, "Part two"),
            b(0, "More."),
        ]);
        assert_eq!(
            s,
            vec![
                "Thursday, December 15, 2022\nThe $8 linux computer\nYes, you read that right.",
                "Part two\nMore."
            ]
        );
    }

    #[test]
    fn drops_empty_blocks_and_sections() {
        assert!(sections(&[b(2, "  "), b(0, "")]).is_empty());
    }

    /// Invariants over many generated pages: nothing lost or reordered,
    /// every section bounded, every top-level heading after body text opens a section.
    #[test]
    fn invariants_hold_for_generated_pages() {
        let mut seed = 0x2545_f491_u64;
        let mut next = move |n: u64| {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            (seed >> 33) % n
        };
        for _ in 0..500 {
            let blocks: Vec<Block> = (0..next(40))
                .map(|_| {
                    let level = [0, 0, 0, 0, 1, 2, 3, 4][next(8) as usize];
                    let len = [0, 3, 40, 900, 5_999, 6_000, 6_001, 14_000][next(8) as usize];
                    let text: String = (0..len)
                        .map(|i| ['a', 'é', ' ', '\n', '∑'][(i + next(5) as usize) % 5])
                        .collect();
                    b(level, &text)
                })
                .collect();
            let s = sections(&blocks);
            assert!(s
                .iter()
                .all(|t| !t.is_empty() && t.chars().count() <= SECTION_MAX_CHARS));
            let squash = |t: &str| t.chars().filter(|c| *c != '\n').collect::<String>();
            let want: String = blocks.iter().map(|b| squash(b.text.trim())).collect();
            let got: String = s.iter().map(|t| squash(t)).collect();
            assert_eq!(got, want);
            // A top-level heading right after body text opens a section.
            let mut after_body = false;
            for h in blocks.iter().filter(|b| !b.text.trim().is_empty()) {
                let top = (1..=3).contains(&h.level);
                if top && after_body {
                    let head: String = h.text.trim().chars().take(20).collect();
                    assert!(
                        s.iter().any(|t| t.starts_with(&head)),
                        "heading not at a section start"
                    );
                }
                after_body = !top;
            }
        }
    }
}
