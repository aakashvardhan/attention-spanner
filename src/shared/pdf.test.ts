import { describe, expect, it, vi } from 'vitest';
import {
  alphaxivUrl,
  articleReaderPath,
  arxivPdfUrl,
  computePdfPercent,
  isPdfResponse,
  isPdfUrl,
  paperOpenUrl,
  paperPdfSource,
  positionFromScroll,
  readerPagePath,
  shouldInterceptPdf,
  shouldOpenInReader,
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

describe('arxivPdfUrl', () => {
  it('builds the PDF URL for new- and old-style arXiv ids', () => {
    expect(arxivPdfUrl('2406.09246')).toBe('https://arxiv.org/pdf/2406.09246');
    expect(arxivPdfUrl('hep-th/9901001')).toBe('https://arxiv.org/pdf/hep-th/9901001');
  });

  it('returns null for a DOI, a plain URL, or junk', () => {
    expect(arxivPdfUrl('10.1145/3292500.3330701')).toBeNull();
    expect(arxivPdfUrl('https://example.com/paper')).toBeNull();
    expect(arxivPdfUrl('')).toBeNull();
  });
});

describe('isPdfResponse', () => {
  it('catches a PDF the URL gives no hint about', () => {
    // allenai.org/papers/molmoact2 — application/pdf, no .pdf in the path
    expect(isPdfResponse('application/pdf', null)).toBe(true);
    expect(isPdfResponse('application/pdf; charset=binary', null)).toBe(true);
    expect(isPdfResponse('APPLICATION/PDF', null)).toBe(true);
  });

  it('ignores anything the browser will not render as a PDF page', () => {
    expect(isPdfResponse('text/html', null)).toBe(false);
    expect(isPdfResponse('application/pdfx', null)).toBe(false);
    expect(isPdfResponse(null, null)).toBe(false);
  });

  it('leaves downloads alone — the tab stays on the page that started them', () => {
    expect(isPdfResponse('application/pdf', 'attachment; filename="paper.pdf"')).toBe(false);
    expect(isPdfResponse('application/pdf', 'inline; filename="paper.pdf"')).toBe(true);
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

describe('shouldOpenInReader', () => {
  it('accepts ordinary web articles', () => {
    expect(shouldOpenInReader('https://example.com/posts/attention')).toBe(true);
    expect(shouldOpenInReader('http://blog.example.org/a')).toBe(true);
  });

  it('rejects PDFs — those take the PDF reader path instead', () => {
    expect(shouldOpenInReader('https://arxiv.org/pdf/2006.11239')).toBe(false);
  });

  it('rejects video pages, which are watched rather than read', () => {
    expect(shouldOpenInReader('https://www.youtube.com/watch?v=abc12345678')).toBe(false);
    expect(shouldOpenInReader('https://youtu.be/abc12345678')).toBe(false);
    expect(shouldOpenInReader('https://vimeo.com/12345')).toBe(false);
  });

  it('rejects non-http schemes and junk', () => {
    expect(shouldOpenInReader('mailto:someone@example.com')).toBe(false);
    expect(shouldOpenInReader('not a url')).toBe(false);
  });
});

describe('paperPdfSource', () => {
  const paper = (url: string, pdf?: { url: string }) =>
    ({ url, pdf: pdf ? { ...pdf, page: 1, pageCount: 10, offset: 0 } : undefined }) as Parameters<
      typeof paperPdfSource
    >[0];

  it('prefers the saved reading position', () => {
    expect(paperPdfSource(paper('https://arxiv.org/abs/2006.11239', { url: 'https://x.com/a.pdf' }))).toBe(
      'https://x.com/a.pdf',
    );
  });

  it('derives the arXiv PDF from an abs link, so a fresh paper opens in the reader', () => {
    expect(paperPdfSource(paper('https://arxiv.org/abs/2006.11239'))).toBe(
      'https://arxiv.org/pdf/2006.11239',
    );
    expect(paperPdfSource(paper('https://arxiv.org/abs/2006.11239v2'))).toBe(
      'https://arxiv.org/pdf/2006.11239',
    );
  });

  it('passes a link that is already a PDF straight through', () => {
    expect(paperPdfSource(paper('https://example.com/paper.pdf'))).toBe(
      'https://example.com/paper.pdf',
    );
  });

  it('has nothing to offer for a publisher page or a paper with no link', () => {
    expect(paperPdfSource(paper('https://dl.acm.org/doi/10.1145/3292500.3330701'))).toBeNull();
    expect(paperPdfSource(paper(''))).toBeNull();
  });
});

describe('articleReaderPath', () => {
  it('encodes the target url into the ?article= param', () => {
    expect(articleReaderPath('https://example.com/a b?x=1')).toBe(
      'src/pages/reader/index.html?article=https%3A%2F%2Fexample.com%2Fa%20b%3Fx%3D1',
    );
  });
});

describe('paperOpenUrl', () => {
  it('sends an arXiv paper to alphaXiv, from an abs or pdf link', () => {
    expect(paperOpenUrl({ url: 'https://arxiv.org/abs/2006.11239v2' })).toBe(
      'https://www.alphaxiv.org/abs/2006.11239',
    );
    expect(paperOpenUrl({ url: 'https://arxiv.org/pdf/hep-th/9901001' })).toBe(
      'https://www.alphaxiv.org/abs/hep-th/9901001',
    );
  });

  it('opens an arXiv paper in the reader when asked to, as the Alt-click fallback', () => {
    vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://id/${path}` } });
    expect(paperOpenUrl({ url: 'https://arxiv.org/abs/2006.11239' }, true)).toBe(
      `chrome-extension://id/${readerPagePath('https://arxiv.org/pdf/2006.11239')}`,
    );
    vi.unstubAllGlobals();
  });

  it('opens a non-arXiv paper as before', () => {
    expect(paperOpenUrl({ url: 'https://dl.acm.org/doi/10.1145/3292500.3330701' })).toBe(
      'https://dl.acm.org/doi/10.1145/3292500.3330701',
    );
  });
});

describe('alphaxivUrl', () => {
  it('maps an intercepted arXiv PDF to its alphaXiv page', () => {
    expect(alphaxivUrl('https://arxiv.org/pdf/2006.11239v3')).toBe('https://www.alphaxiv.org/abs/2006.11239');
  });

  it('is null for a PDF that is not on arXiv', () => {
    expect(alphaxivUrl('https://example.com/paper.pdf')).toBeNull();
  });
});
