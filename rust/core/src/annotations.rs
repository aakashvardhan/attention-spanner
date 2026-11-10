//! Highlights and sticky notes: turning a
//! selection's client rects into page fractions, and reading order.

use crate::constants::{ANNOTATION_TEXT_MAX_CHARS, MAX_ANNOTATIONS};
use crate::messages::{AnnotationDraft, AnnotationPatch};
use crate::papers::paper_match_key;
use crate::types::{Annotation, AnnotationAnchor, AnnotationColor, AnnotationKind, AnnotationRect};
use std::cmp::Ordering;

/// Highlight tints: translucent so the canvas text stays readable underneath.
pub fn annotation_tint(color: AnnotationColor) -> &'static str {
    match color {
        AnnotationColor::Yellow => "rgba(255, 213, 79, 0.45)",
        AnnotationColor::Green => "rgba(129, 199, 132, 0.45)",
        AnnotationColor::Blue => "rgba(100, 181, 246, 0.45)",
        AnnotationColor::Pink => "rgba(244, 143, 177, 0.45)",
    }
}

/// Solid variants for small UI chips (swatches, pins, sidebar dots).
pub fn annotation_swatch(color: AnnotationColor) -> &'static str {
    match color {
        AnnotationColor::Yellow => "#f5c518",
        AnnotationColor::Green => "#66bb6a",
        AnnotationColor::Blue => "#42a5f5",
        AnnotationColor::Pink => "#ec6ea8",
    }
}

pub const DEFAULT_ANNOTATION_COLOR: AnnotationColor = AnnotationColor::Yellow;

/// The document key for a reader URL: arXiv variants collapse; anything
/// unparseable keys on itself.
pub fn annotation_doc_key(pdf_url: &str) -> String {
    paper_match_key(pdf_url).unwrap_or_else(|| pdf_url.to_string())
}

/// A DOM rect in CSS pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Box {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// Rects smaller than this (CSS px) are punctuation slivers.
const MIN_RECT_PX: f64 = 2.0;

/// Client rects → 0-1 page-relative rects, slivers dropped, clamped to the page.
pub fn normalize_rects(rects: &[Box], page: Box) -> Vec<AnnotationRect> {
    if page.width <= 0.0 || page.height <= 0.0 {
        return vec![];
    }
    let fx = |v: f64| ((v - page.left) / page.width).clamp(0.0, 1.0);
    let fy = |v: f64| ((v - page.top) / page.height).clamp(0.0, 1.0);
    rects
        .iter()
        .filter(|r| r.width >= MIN_RECT_PX && r.height >= MIN_RECT_PX)
        .filter_map(|r| {
            let (x, y) = (fx(r.left), fy(r.top));
            let (w, h) = (fx(r.left + r.width) - x, fy(r.top + r.height) - y);
            (w > 0.0 && h > 0.0).then_some(AnnotationRect { x, y, w, h })
        })
        .collect()
}

fn center(r: &AnnotationRect) -> f64 {
    r.y + r.h / 2.0
}

/// Merge one visual line's fragments (pdf.js emits a span per text run) into
/// single boxes: rects whose centres are within half the smaller height share
/// a line; on a line, overlapping or near (0.4 × line height) rects merge.
/// Sorted top to bottom.
pub fn merge_line_rects(rects: &[AnnotationRect]) -> Vec<AnnotationRect> {
    if rects.len() <= 1 {
        return rects.to_vec();
    }
    let mut sorted = rects.to_vec();
    // f64 has no total order (NaN), so sort_by takes partial_cmp and a fallback.
    sorted.sort_by(|a, b| center(a).partial_cmp(&center(b)).unwrap_or(Ordering::Equal));
    let mut lines: Vec<Vec<AnnotationRect>> = Vec::new();
    for rect in sorted {
        match lines.last_mut() {
            Some(line)
                if (center(&rect) - center(line.last().unwrap())).abs()
                    < rect.h.min(line.last().unwrap().h) / 2.0 =>
            {
                line.push(rect)
            }
            _ => lines.push(vec![rect]),
        }
    }
    let mut out = Vec::new();
    for mut line in lines {
        line.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(Ordering::Equal));
        let mut current = line[0];
        for rect in &line[1..] {
            let max_gap = 0.4 * current.h.max(rect.h);
            if rect.x <= current.x + current.w + max_gap {
                let right = (current.x + current.w).max(rect.x + rect.w);
                let top = current.y.min(rect.y);
                let bottom = (current.y + current.h).max(rect.y + rect.h);
                current = AnnotationRect {
                    x: current.x,
                    y: top,
                    w: right - current.x,
                    h: bottom - top,
                };
            } else {
                out.push(current);
                current = *rect;
            }
        }
        out.push(current);
    }
    out.sort_by(|a, b| {
        a.y.partial_cmp(&b.y)
            .unwrap_or(Ordering::Equal)
            .then(a.x.partial_cmp(&b.x).unwrap_or(Ordering::Equal))
    });
    out
}

/// 0-1 vertical anchor within a PDF page: the pin for stickies, the topmost rect for highlights.
pub fn annotation_offset(a: &Annotation) -> f64 {
    match &a.anchor {
        AnnotationAnchor::Pdf { y, .. } if a.kind == AnnotationKind::Sticky => *y,
        AnnotationAnchor::Pdf { rects, .. } => rects
            .iter()
            .map(|r| r.y)
            .fold(None, |m: Option<f64>, y| Some(m.map_or(y, |m| m.min(y))))
            .unwrap_or(0.0),
        AnnotationAnchor::Text { .. } => 0.0,
    }
}

/// Reading order: page (or block), then vertical position.
pub fn sort_annotations(list: &[Annotation]) -> Vec<Annotation> {
    let seq = |a: &Annotation| match &a.anchor {
        AnnotationAnchor::Pdf { page, .. } => *page,
        AnnotationAnchor::Text { block_index, .. } => *block_index,
    };
    let mut out = list.to_vec();
    // A stable sort, like Array.prototype.sort: equal keys keep their order.
    out.sort_by(|a, b| {
        seq(a).cmp(&seq(b)).then(
            annotation_offset(a)
                .partial_cmp(&annotation_offset(b))
                .unwrap_or(Ordering::Equal),
        )
    });
    out
}

fn truncate(s: &str) -> String {
    s.chars().take(ANNOTATION_TEXT_MAX_CHARS).collect()
}

/// A draft is only usable if its anchor can locate something.
fn anchor_problem(draft: &AnnotationDraft) -> Option<&'static str> {
    match &draft.anchor {
        AnnotationAnchor::Pdf { page, .. } if *page < 1 => Some("Invalid page number."),
        AnnotationAnchor::Pdf { rects, .. }
            if draft.kind == AnnotationKind::Highlight && rects.is_empty() =>
        {
            Some("Highlight has no selection rects.")
        }
        AnnotationAnchor::Text { quote, .. }
            if draft.kind == AnnotationKind::Highlight && quote.trim().is_empty() =>
        {
            Some("Highlight has no quoted text.")
        }
        _ => None,
    }
}

/// The worker's writes as list transforms:
/// the list in, the new list (and the made record) out, or why not.
pub fn add_annotation(
    list: &[Annotation],
    draft: AnnotationDraft,
    id: String,
    now: i64,
) -> Result<(Vec<Annotation>, Annotation), String> {
    if draft.doc_key.is_empty() {
        return Err("Annotation has no document key.".into());
    }
    if let Some(problem) = anchor_problem(&draft) {
        return Err(problem.into());
    }
    if list.len() >= MAX_ANNOTATIONS {
        return Err(format!("Annotation limit reached ({MAX_ANNOTATIONS})."));
    }
    let mut annotation = draft.into_annotation(id, now);
    annotation.text = truncate(&annotation.text);
    annotation.note = truncate(&annotation.note);
    let mut next = list.to_vec();
    next.push(annotation.clone());
    Ok((next, annotation))
}

pub fn update_annotation(
    list: &[Annotation],
    id: &str,
    patch: AnnotationPatch,
    now: i64,
) -> Result<Vec<Annotation>, String> {
    let mut next = list.to_vec();
    let a = next
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or("Annotation not found.")?;
    if let Some(note) = patch.note {
        a.note = truncate(&note);
    }
    if let Some(color) = patch.color {
        a.color = color;
    }
    a.updated_at = now;
    Ok(next)
}

/// Move a sticky pin; PDF-anchored only.
pub fn move_annotation(
    list: &[Annotation],
    id: &str,
    x: f64,
    y: f64,
    now: i64,
) -> Result<Vec<Annotation>, String> {
    let mut next = list.to_vec();
    let a = next
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or("Annotation not found.")?;
    let AnnotationAnchor::Pdf { x: ax, y: ay, .. } = &mut a.anchor else {
        return Err("Not a positioned annotation.".into());
    };
    (*ax, *ay) = (x, y);
    a.updated_at = now;
    Ok(next)
}

pub fn delete_annotation(list: &[Annotation], id: &str) -> Vec<Annotation> {
    list.iter().filter(|a| a.id != id).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: Box = Box {
        left: 100.0,
        top: 200.0,
        width: 800.0,
        height: 1000.0,
    };
    fn r(x: f64, y: f64, w: f64, h: f64) -> AnnotationRect {
        AnnotationRect { x, y, w, h }
    }
    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn doc_key_collapses_arxiv_variants_and_falls_back_to_the_url() {
        assert_eq!(
            annotation_doc_key("https://arxiv.org/pdf/2006.11239"),
            annotation_doc_key("https://arxiv.org/abs/2006.11239v2")
        );
        assert_eq!(annotation_doc_key("not a url"), "not a url");
    }

    #[test]
    fn normalize_maps_client_rects_to_page_fractions() {
        let out = normalize_rects(
            &[Box {
                left: 300.0,
                top: 450.0,
                width: 400.0,
                height: 20.0,
            }],
            PAGE,
        );
        assert!(
            close(out[0].x, 0.25)
                && close(out[0].y, 0.25)
                && close(out[0].w, 0.5)
                && close(out[0].h, 0.02)
        );
    }

    #[test]
    fn normalize_drops_slivers_and_clamps_overshoot() {
        let out = normalize_rects(
            &[
                Box {
                    left: 300.0,
                    top: 450.0,
                    width: 1.0,
                    height: 20.0,
                },
                Box {
                    left: 850.0,
                    top: 1150.0,
                    width: 200.0,
                    height: 100.0,
                },
            ],
            PAGE,
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].x + out[0].w <= 1.0 && out[0].y + out[0].h <= 1.0);
    }

    #[test]
    fn merges_abutting_fragments_of_one_line() {
        let m = merge_line_rects(&[
            r(0.1, 0.5, 0.2, 0.02),
            r(0.301, 0.5, 0.2, 0.02),
            r(0.502, 0.5, 0.1, 0.02),
        ]);
        assert_eq!(m.len(), 1);
        assert!(close(m[0].x, 0.1) && close(m[0].x + m[0].w, 0.602));
    }

    #[test]
    fn keeps_lines_separate_sorted_top_to_bottom() {
        let m = merge_line_rects(&[r(0.1, 0.7, 0.5, 0.02), r(0.1, 0.5, 0.5, 0.02)]);
        assert_eq!(m.len(), 2);
        assert!(m[0].y < m[1].y);
    }

    #[test]
    fn absorbs_contained_rects_and_keeps_wide_gaps_apart() {
        let m = merge_line_rects(&[r(0.1, 0.5, 0.5, 0.02), r(0.2, 0.5, 0.1, 0.02)]);
        assert_eq!(m.len(), 1);
        assert!(close(m[0].x, 0.1) && close(m[0].w, 0.5));
        assert_eq!(
            merge_line_rects(&[r(0.1, 0.5, 0.1, 0.02), r(0.6, 0.5, 0.1, 0.02)]).len(),
            2
        );
    }

    fn base(id: &str, kind: AnnotationKind, anchor: AnnotationAnchor) -> Annotation {
        Annotation {
            id: id.into(),
            doc_key: "k".into(),
            doc_url: "u".into(),
            paper_id: None,
            kind,
            anchor,
            text: String::new(),
            color: AnnotationColor::Yellow,
            note: String::new(),
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
        }
    }
    fn pdf(page: u32, rects: Vec<AnnotationRect>, y: f64) -> AnnotationAnchor {
        AnnotationAnchor::Pdf {
            page,
            rects,
            x: 0.0,
            y,
        }
    }
    fn text(block_index: u32) -> AnnotationAnchor {
        AnnotationAnchor::Text {
            block_index,
            quote: "q".into(),
            prefix: String::new(),
            suffix: String::new(),
        }
    }

    #[test]
    fn anchors_highlights_at_the_top_rect_and_stickies_at_the_pin() {
        let h = base(
            "a",
            AnnotationKind::Highlight,
            pdf(1, vec![r(0.1, 0.6, 0.2, 0.02), r(0.1, 0.3, 0.2, 0.02)], 0.0),
        );
        assert_eq!(annotation_offset(&h), 0.3);
        assert_eq!(
            annotation_offset(&base("s", AnnotationKind::Sticky, pdf(1, vec![], 0.8))),
            0.8
        );
        assert_eq!(
            annotation_offset(&base("t", AnnotationKind::Highlight, text(3))),
            0.0
        );
    }

    fn draft(kind: AnnotationKind, anchor: AnnotationAnchor) -> AnnotationDraft {
        AnnotationDraft {
            doc_key: "arxiv:1".into(),
            doc_url: "u".into(),
            paper_id: None,
            kind,
            anchor,
            text: "t".into(),
            color: AnnotationColor::Yellow,
            note: String::new(),
        }
    }

    #[test]
    fn add_validates_the_anchor_and_the_limit_and_truncates() {
        let ok = draft(
            AnnotationKind::Highlight,
            pdf(1, vec![r(0.0, 0.0, 0.1, 0.1)], 0.0),
        );
        let (list, made) = add_annotation(
            &[],
            AnnotationDraft {
                note: "n".repeat(900),
                ..ok.clone()
            },
            "id1".into(),
            5,
        )
        .unwrap();
        assert_eq!(
            (
                list.len(),
                made.id.as_str(),
                made.created_at,
                made.note.chars().count()
            ),
            (1, "id1", 5, 500)
        );
        assert_eq!(
            add_annotation(
                &[],
                AnnotationDraft {
                    doc_key: String::new(),
                    ..ok.clone()
                },
                "x".into(),
                0
            )
            .unwrap_err(),
            "Annotation has no document key."
        );
        assert_eq!(
            add_annotation(
                &[],
                draft(
                    AnnotationKind::Highlight,
                    pdf(0, vec![r(0.0, 0.0, 0.1, 0.1)], 0.0)
                ),
                "x".into(),
                0
            )
            .unwrap_err(),
            "Invalid page number."
        );
        assert_eq!(
            add_annotation(
                &[],
                draft(AnnotationKind::Highlight, pdf(1, vec![], 0.0)),
                "x".into(),
                0
            )
            .unwrap_err(),
            "Highlight has no selection rects."
        );
        assert!(add_annotation(
            &[],
            draft(AnnotationKind::Sticky, pdf(1, vec![], 0.5)),
            "x".into(),
            0
        )
        .is_ok());
        let full = vec![made; MAX_ANNOTATIONS];
        assert_eq!(
            add_annotation(&full, ok, "x".into(), 0).unwrap_err(),
            "Annotation limit reached (2000)."
        );
    }

    #[test]
    fn update_move_and_delete() {
        let (list, _) = add_annotation(
            &[],
            draft(AnnotationKind::Sticky, pdf(1, vec![], 0.5)),
            "a".into(),
            1,
        )
        .unwrap();
        let list = update_annotation(
            &list,
            "a",
            AnnotationPatch {
                note: Some("hi".into()),
                color: Some(AnnotationColor::Blue),
            },
            2,
        )
        .unwrap();
        assert_eq!(
            (list[0].note.as_str(), list[0].color, list[0].updated_at),
            ("hi", AnnotationColor::Blue, 2)
        );
        let list = move_annotation(&list, "a", 0.3, 0.7, 3).unwrap();
        assert!(
            matches!(list[0].anchor, AnnotationAnchor::Pdf { x, y, .. } if x == 0.3 && y == 0.7)
        );
        assert_eq!(
            update_annotation(&list, "nope", AnnotationPatch::default(), 4).unwrap_err(),
            "Annotation not found."
        );
        let text = add_annotation(&[], draft(AnnotationKind::Sticky, text(1)), "t".into(), 1)
            .unwrap()
            .0;
        assert_eq!(
            move_annotation(&text, "t", 0.1, 0.1, 2).unwrap_err(),
            "Not a positioned annotation."
        );
        assert!(delete_annotation(&list, "a").is_empty());
    }

    #[test]
    fn sorts_by_page_then_position_and_text_by_block() {
        let list = [
            base("p2", AnnotationKind::Highlight, pdf(2, vec![], 0.0)),
            base(
                "low",
                AnnotationKind::Highlight,
                pdf(1, vec![r(0.0, 0.9, 0.1, 0.02)], 0.0),
            ),
            base(
                "high",
                AnnotationKind::Highlight,
                pdf(1, vec![r(0.0, 0.1, 0.1, 0.02)], 0.0),
            ),
        ];
        assert_eq!(
            sort_annotations(&list)
                .iter()
                .map(|a| a.id.as_str())
                .collect::<Vec<_>>(),
            ["high", "low", "p2"]
        );
        let blocks = [
            base("c", AnnotationKind::Highlight, text(5)),
            base("a", AnnotationKind::Highlight, text(0)),
            base("b", AnnotationKind::Highlight, text(2)),
        ];
        assert_eq!(
            sort_annotations(&blocks)
                .iter()
                .map(|a| a.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b", "c"]
        );
    }
}
