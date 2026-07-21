import { paperMatchKey } from './papers';
import type { AnnotationColor, AnnotationRect, PdfAnnotation } from './types';

/** Highlight tints — translucent so canvas text stays readable underneath. */
export const ANNOTATION_COLORS: Record<AnnotationColor, string> = {
  yellow: 'rgba(255, 213, 79, 0.45)',
  green: 'rgba(129, 199, 132, 0.45)',
  blue: 'rgba(100, 181, 246, 0.45)',
  pink: 'rgba(244, 143, 177, 0.45)',
};

/** Solid variants for UI chips (swatch buttons, pins, sidebar dots) — the
 * translucent tints above read as washed-out at small sizes. */
export const ANNOTATION_SWATCH_COLORS: Record<AnnotationColor, string> = {
  yellow: '#f5c518',
  green: '#66bb6a',
  blue: '#42a5f5',
  pink: '#ec6ea8',
};

export const DEFAULT_ANNOTATION_COLOR: AnnotationColor = 'yellow';

/**
 * Stable annotation key for a reader src URL. paperMatchKey collapses arXiv
 * abs/pdf/versioned variants; the raw URL is the last-resort fallback so
 * annotations still round-trip on URLs the matcher can't parse.
 */
export function annotationDocKey(pdfUrl: string): string {
  return paperMatchKey(pdfUrl) ?? pdfUrl;
}

interface BoxLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Selection rects smaller than this (CSS px) are punctuation slivers — drop them. */
const MIN_RECT_PX = 2;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Client rects → 0–1 page-relative rects. Drops sub-pixel slivers and clamps
 * to the page box so a selection that overshoots the page edge stays inside.
 */
export function normalizeRects(rects: BoxLike[], page: BoxLike): AnnotationRect[] {
  if (page.width <= 0 || page.height <= 0) return [];
  const out: AnnotationRect[] = [];
  for (const r of rects) {
    if (r.width < MIN_RECT_PX || r.height < MIN_RECT_PX) continue;
    const x = clamp01((r.left - page.left) / page.width);
    const y = clamp01((r.top - page.top) / page.height);
    const w = clamp01((r.left + r.width - page.left) / page.width) - x;
    const h = clamp01((r.top + r.height - page.top) / page.height) - y;
    if (w <= 0 || h <= 0) continue;
    out.push({ x, y, w, h });
  }
  return out;
}

/**
 * Merge same-line selection fragments into single boxes. pdf.js emits one span
 * per text run, so one visual line arrives as several abutting client rects;
 * browsers also report rects fully contained in others. Rects whose vertical
 * centers are within half the smaller height belong to one line; within a
 * line, rects that overlap or sit within a small gap (0.4 × line height)
 * merge. Output is sorted top-to-bottom.
 */
export function mergeLineRects(rects: AnnotationRect[]): AnnotationRect[] {
  if (rects.length <= 1) return [...rects];

  // Group into lines by vertical-center proximity.
  const sorted = [...rects].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  const lines: AnnotationRect[][] = [];
  for (const rect of sorted) {
    const line = lines[lines.length - 1];
    if (line) {
      const prev = line[line.length - 1];
      const gap = Math.abs(rect.y + rect.h / 2 - (prev.y + prev.h / 2));
      if (gap < Math.min(rect.h, prev.h) / 2) {
        line.push(rect);
        continue;
      }
    }
    lines.push([rect]);
  }

  const out: AnnotationRect[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    let current = { ...line[0] };
    for (const rect of line.slice(1)) {
      const maxGap = 0.4 * Math.max(current.h, rect.h);
      if (rect.x <= current.x + current.w + maxGap) {
        const right = Math.max(current.x + current.w, rect.x + rect.w);
        const top = Math.min(current.y, rect.y);
        const bottom = Math.max(current.y + current.h, rect.y + rect.h);
        current = { x: current.x, y: top, w: right - current.x, h: bottom - top };
      } else {
        out.push(current);
        current = { ...rect };
      }
    }
    out.push(current);
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** 0–1 vertical anchor within the page, for scrollToPosition jumps. */
export function annotationOffset(a: Pick<PdfAnnotation, 'kind' | 'rects' | 'y'>): number {
  if (a.kind === 'sticky') return a.y;
  return a.rects.length ? Math.min(...a.rects.map((r) => r.y)) : 0;
}

/** Reading order: page, then vertical position within the page. */
export function sortAnnotations(list: PdfAnnotation[]): PdfAnnotation[] {
  return [...list].sort((a, b) => a.page - b.page || annotationOffset(a) - annotationOffset(b));
}
