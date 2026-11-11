//! Folding a reader position into a paper.

use crate::pdf::compute_pdf_percent;
use crate::types::{Paper, PdfState};

/// Don't rewrite lastReadAt more than once a minute while a tab stays open.
pub(crate) const READING_TOUCH_THROTTLE_MS: i64 = 60_000;

#[derive(Debug, Clone, PartialEq)]
pub struct ReaderPosition {
    pub pdf_url: String,
    pub page: f64,
    pub page_count: f64,
    pub offset: f64,
    /// Outline-derived note; '' when the reader has nothing better
    pub left_off: String,
}

/// Progress only ratchets up; the resume position always follows the latest
/// report. Mutates `paper` and says whether anything changed.
pub fn apply_reader_progress(paper: &mut Paper, pos: &ReaderPosition, now: i64) -> bool {
    let page_count = pos.page_count.round().max(1.0) as u32;
    let page = (pos.page.round().max(1.0) as u32).min(page_count);
    // Rounded so near-identical scroll reports don't churn updatedAt.
    let offset = (pos.offset.clamp(0.0, 1.0) * 1000.0).round() / 1000.0;

    let mut changed = false;
    let next = PdfState {
        url: pos.pdf_url.clone(),
        page,
        page_count,
        offset,
    };
    if paper.pdf.as_ref() != Some(&next) {
        paper.pdf = Some(next);
        changed = true;
    }
    let percent = f64::from(compute_pdf_percent(page, page_count, offset));
    if percent > paper.progress_percent {
        paper.progress_percent = percent;
        changed = true;
    }
    let left_off = pos.left_off.trim();
    if !left_off.is_empty() && left_off != paper.left_off {
        paper.left_off = left_off.to_string();
        changed = true;
    }
    if paper
        .last_read_at
        .is_none_or(|t| now - t > READING_TOUCH_THROTTLE_MS)
    {
        paper.last_read_at = Some(now);
        changed = true;
    }
    if changed {
        paper.updated_at = now;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_700_000_000_000;

    fn paper() -> Paper {
        Paper {
            id: "2006.11239".into(),
            title: "Denoising Diffusion Probabilistic Models".into(),
            authors: "Ho, Jain, Abbeel".into(),
            year: Some(2020),
            url: "https://arxiv.org/abs/2006.11239".into(),
            folder_ids: vec![],
            progress_percent: 0.0,
            left_off: String::new(),
            pdf: None,
            added_at: T0,
            updated_at: T0,
            last_read_at: None,
        }
    }
    fn pos() -> ReaderPosition {
        ReaderPosition {
            pdf_url: "https://arxiv.org/pdf/2006.11239".into(),
            page: 5.0,
            page_count: 20.0,
            offset: 0.5,
            left_off: "3 Diffusion models".into(),
        }
    }

    #[test]
    fn stores_the_position_and_ratchets_percent() {
        let mut p = paper();
        assert!(apply_reader_progress(&mut p, &pos(), T0 + 1000));
        assert_eq!(
            p.pdf,
            Some(PdfState {
                url: "https://arxiv.org/pdf/2006.11239".into(),
                page: 5,
                page_count: 20,
                offset: 0.5
            })
        );
        assert_eq!(p.progress_percent, 23.0);
        assert_eq!(p.left_off, "3 Diffusion models");
        assert_eq!((p.last_read_at, p.updated_at), (Some(T0 + 1000), T0 + 1000));
    }

    #[test]
    fn never_lowers_progress_when_scrolling_back() {
        let mut p = Paper {
            progress_percent: 60.0,
            ..paper()
        };
        apply_reader_progress(
            &mut p,
            &ReaderPosition {
                page: 2.0,
                offset: 0.0,
                ..pos()
            },
            T0 + 1000,
        );
        assert_eq!(p.progress_percent, 60.0);
        assert_eq!(p.pdf.unwrap().page, 2);
    }

    #[test]
    fn keeps_left_off_when_the_reader_reports_none() {
        let mut p = Paper {
            left_off: "my own note".into(),
            ..paper()
        };
        apply_reader_progress(
            &mut p,
            &ReaderPosition {
                left_off: String::new(),
                ..pos()
            },
            T0 + 1000,
        );
        assert_eq!(p.left_off, "my own note");
    }

    #[test]
    fn throttles_last_read_but_bumps_updated_on_a_move() {
        let mut p = Paper {
            last_read_at: Some(T0),
            ..paper()
        };
        apply_reader_progress(&mut p, &pos(), T0 + 5000);
        assert_eq!((p.last_read_at, p.updated_at), (Some(T0), T0 + 5000));
        apply_reader_progress(&mut p, &ReaderPosition { page: 6.0, ..pos() }, T0 + 61_000);
        assert_eq!(p.last_read_at, Some(T0 + 61_000));
    }

    #[test]
    fn an_identical_repeat_inside_the_throttle_changes_nothing() {
        let mut p = paper();
        apply_reader_progress(&mut p, &pos(), T0 + 1000);
        assert!(!apply_reader_progress(&mut p, &pos(), T0 + 2000));
        assert_eq!(p.updated_at, T0 + 1000);
    }

    #[test]
    fn clamps_out_of_range_pages_and_offsets() {
        let mut p = paper();
        apply_reader_progress(
            &mut p,
            &ReaderPosition {
                page: 99.0,
                offset: 7.0,
                ..pos()
            },
            T0 + 1000,
        );
        let pdf = p.pdf.unwrap();
        assert_eq!((pdf.page, pdf.offset), (20, 1.0));
        assert_eq!(p.progress_percent, 100.0);
    }
}
