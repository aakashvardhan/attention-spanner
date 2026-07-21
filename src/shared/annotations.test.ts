import { describe, expect, it } from 'vitest';
import {
  annotationDocKey,
  annotationOffset,
  mergeLineRects,
  normalizeRects,
  sortAnnotations,
} from './annotations';
import type { AnnotationRect, PdfAnnotation } from './types';

const page = { left: 100, top: 200, width: 800, height: 1000 };

describe('annotationDocKey', () => {
  it('collapses arXiv abs/pdf variants to one key', () => {
    expect(annotationDocKey('https://arxiv.org/pdf/2006.11239')).toBe(
      annotationDocKey('https://arxiv.org/abs/2006.11239v2'),
    );
  });

  it('falls back to the raw URL when nothing is parseable', () => {
    expect(annotationDocKey('not a url')).toBe('not a url');
  });
});

describe('normalizeRects', () => {
  it('maps client rects to 0–1 page fractions', () => {
    const [r] = normalizeRects([{ left: 300, top: 450, width: 400, height: 20 }], page);
    expect(r.x).toBeCloseTo(0.25);
    expect(r.y).toBeCloseTo(0.25);
    expect(r.w).toBeCloseTo(0.5);
    expect(r.h).toBeCloseTo(0.02);
  });

  it('drops slivers and clamps overshoot to the page box', () => {
    const rects = normalizeRects(
      [
        { left: 300, top: 450, width: 1, height: 20 }, // sliver
        { left: 850, top: 1150, width: 200, height: 100 }, // overshoots right/bottom
      ],
      page,
    );
    expect(rects).toHaveLength(1);
    expect(rects[0].x + rects[0].w).toBeLessThanOrEqual(1);
    expect(rects[0].y + rects[0].h).toBeLessThanOrEqual(1);
  });
});

describe('mergeLineRects', () => {
  it('merges abutting fragments of one visual line into a single box', () => {
    const merged = mergeLineRects([
      { x: 0.1, y: 0.5, w: 0.2, h: 0.02 },
      { x: 0.301, y: 0.5, w: 0.2, h: 0.02 },
      { x: 0.502, y: 0.5, w: 0.1, h: 0.02 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].x).toBeCloseTo(0.1);
    expect(merged[0].x + merged[0].w).toBeCloseTo(0.602);
  });

  it('keeps separate lines separate, sorted top-to-bottom', () => {
    const merged = mergeLineRects([
      { x: 0.1, y: 0.7, w: 0.5, h: 0.02 },
      { x: 0.1, y: 0.5, w: 0.5, h: 0.02 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].y).toBeLessThan(merged[1].y);
  });

  it('absorbs rects fully contained in a larger one on the same line', () => {
    const merged = mergeLineRects([
      { x: 0.1, y: 0.5, w: 0.5, h: 0.02 },
      { x: 0.2, y: 0.5, w: 0.1, h: 0.02 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].x).toBeCloseTo(0.1);
    expect(merged[0].w).toBeCloseTo(0.5);
  });

  it('does not merge fragments separated by a wide gap', () => {
    const merged = mergeLineRects([
      { x: 0.1, y: 0.5, w: 0.1, h: 0.02 },
      { x: 0.6, y: 0.5, w: 0.1, h: 0.02 },
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe('annotationOffset / sortAnnotations', () => {
  const base = (over: Partial<PdfAnnotation>): PdfAnnotation => ({
    id: over.id ?? 'a',
    docKey: 'k',
    pdfUrl: 'u',
    paperId: null,
    kind: 'highlight',
    page: 1,
    rects: [],
    x: 0,
    y: 0,
    text: '',
    color: 'yellow',
    note: '',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });

  it('anchors highlights at the topmost rect and stickies at the pin', () => {
    const rects: AnnotationRect[] = [
      { x: 0.1, y: 0.6, w: 0.2, h: 0.02 },
      { x: 0.1, y: 0.3, w: 0.2, h: 0.02 },
    ];
    expect(annotationOffset(base({ rects }))).toBe(0.3);
    expect(annotationOffset(base({ kind: 'sticky', y: 0.8 }))).toBe(0.8);
  });

  it('sorts by page then vertical position', () => {
    const list = [
      base({ id: 'p2', page: 2 }),
      base({ id: 'low', page: 1, rects: [{ x: 0, y: 0.9, w: 0.1, h: 0.02 }] }),
      base({ id: 'high', page: 1, rects: [{ x: 0, y: 0.1, w: 0.1, h: 0.02 }] }),
    ];
    expect(sortAnnotations(list).map((a) => a.id)).toEqual(['high', 'low', 'p2']);
  });
});
