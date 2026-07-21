import { describe, expect, it } from 'vitest';
import {
  computePdfPercent,
  isPdfUrl,
  positionFromScroll,
  readerPagePath,
  shouldInterceptPdf,
} from './pdf';

describe('isPdfUrl', () => {
  it('matches .pdf paths, with or without a query string', () => {
    expect(isPdfUrl('https://example.com/files/paper.pdf')).toBe(true);
    expect(isPdfUrl('https://example.com/paper.PDF?download=1')).toBe(true);
  });

  it('matches suffixless arXiv and OpenReview PDF paths', () => {
    expect(isPdfUrl('https://arxiv.org/pdf/2006.11239')).toBe(true);
    expect(isPdfUrl('https://www.arxiv.org/pdf/2006.11239v2')).toBe(true);
    expect(isPdfUrl('https://openreview.net/pdf?id=abc123')).toBe(true);
    expect(isPdfUrl('https://arxiv.org/abs/2006.11239')).toBe(false);
  });

  it('rejects non-http schemes and .pdf only in the query', () => {
    expect(isPdfUrl('chrome-extension://abc/src/pages/reader/index.html?src=x.pdf')).toBe(false);
    expect(isPdfUrl('file:///Users/me/paper.pdf')).toBe(false);
    expect(isPdfUrl('https://example.com/view?file=paper.pdf')).toBe(false);
    expect(isPdfUrl('not a url')).toBe(false);
  });
});

describe('shouldInterceptPdf', () => {
  it('skips URLs the user sent to the native viewer', () => {
    const url = 'https://arxiv.org/pdf/2006.11239';
    expect(shouldInterceptPdf(url, [])).toBe(true);
    expect(shouldInterceptPdf(url, [url])).toBe(false);
    expect(shouldInterceptPdf(url, ['https://other.com/a.pdf'])).toBe(true);
  });
});

describe('readerPagePath', () => {
  it('round-trips URLs containing & and #', () => {
    const src = 'https://example.com/paper.pdf?a=1&b=2#page=3';
    const parsed = new URL(`chrome-extension://abc/${readerPagePath(src)}`);
    expect(parsed.searchParams.get('src')).toBe(src);
  });
});

describe('positionFromScroll', () => {
  // Three 100px pages with 10px gaps: tops at 0, 110, 220.
  const tops = [0, 110, 220];
  const heights = [100, 100, 100];

  it('finds the page containing the midpoint and its offset', () => {
    expect(positionFromScroll(tops, heights, 0)).toEqual({ page: 1, offset: 0 });
    expect(positionFromScroll(tops, heights, 50)).toEqual({ page: 1, offset: 0.5 });
    expect(positionFromScroll(tops, heights, 160)).toEqual({ page: 2, offset: 0.5 });
  });

  it('clamps within gaps and past the last page', () => {
    // Midpoint in the gap after page 1 clamps to that page's end.
    expect(positionFromScroll(tops, heights, 105)).toEqual({ page: 1, offset: 1 });
    expect(positionFromScroll(tops, heights, 9999)).toEqual({ page: 3, offset: 1 });
  });

  it('handles an empty document', () => {
    expect(positionFromScroll([], [], 0)).toEqual({ page: 1, offset: 0 });
  });
});

describe('computePdfPercent', () => {
  it('maps position to 0–100', () => {
    expect(computePdfPercent(1, 10, 0)).toBe(0);
    expect(computePdfPercent(6, 10, 0.5)).toBe(55);
    expect(computePdfPercent(10, 10, 1)).toBe(100);
  });

  it('clamps and survives a zero page count', () => {
    expect(computePdfPercent(11, 10, 1)).toBe(100);
    expect(computePdfPercent(1, 0, 0)).toBe(0);
  });
});
