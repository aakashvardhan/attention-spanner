import { READER_PAGE_PATH } from './constants';
import type { Paper } from './types';

/* Pure helpers for the in-extension PDF reader: deciding which navigations to
   intercept, mapping scroll position to a page, and building reader URLs. The
   chrome.* calls stay in the background/pages so everything here is testable. */

/**
 * Does this URL look like a PDF we should open in the reader? URL-only check —
 * without the webRequest permission we can't see Content-Type, so publisher
 * PDFs served from extensionless URLs are missed. Those can still be opened in
 * the reader from the papers page (it takes any URL via ?src=).
 */
export function isPdfUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  // http(s) only — this also guarantees the reader's own chrome-extension://
  // URL never matches, so interception can't loop.
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (/\.pdf$/i.test(u.pathname)) return true;
  const host = u.host.replace(/^www\./i, '').toLowerCase();
  // Modern arXiv PDF paths have no .pdf suffix; same for OpenReview.
  if ((host === 'arxiv.org' || host === 'export.arxiv.org') && u.pathname.startsWith('/pdf/')) {
    return true;
  }
  if (host === 'openreview.net' && u.pathname === '/pdf') return true;
  return false;
}

/** Intercept unless the user chose "Open in Chrome's viewer" for this URL. */
export function shouldInterceptPdf(url: string, bypass: string[]): boolean {
  return isPdfUrl(url) && !bypass.includes(url);
}

/** Extension-relative reader URL (path + query); pure so it can be tested. */
export function readerPagePath(pdfUrl: string): string {
  return `${READER_PAGE_PATH}?src=${encodeURIComponent(pdfUrl)}`;
}

/** Absolute chrome-extension:// URL for opening the reader on a PDF. */
export function readerPageUrl(pdfUrl: string): string {
  return chrome.runtime.getURL(readerPagePath(pdfUrl));
}

/**
 * Where "open this paper" should go: the reader (resuming the saved position)
 * once the paper has been read there, otherwise the paper's own URL.
 */
export function paperOpenUrl(paper: Pick<Paper, 'url' | 'pdf'>): string {
  return paper.pdf?.url ? readerPageUrl(paper.pdf.url) : paper.url;
}

/** 1-based page + 0–1 offset within it, from the viewport-midpoint y. */
export interface PdfPosition {
  page: number;
  offset: number;
}

/**
 * Map a y coordinate (the viewport midpoint, in scroll-content pixels) to the
 * page slab that contains it. `pageTops` are cumulative content offsets (gaps
 * included), parallel to `pageHeights`.
 */
export function positionFromScroll(
  pageTops: number[],
  pageHeights: number[],
  scrollMid: number,
): PdfPosition {
  if (pageTops.length === 0) return { page: 1, offset: 0 };
  let index = 0;
  for (let i = 0; i < pageTops.length; i++) {
    if (pageTops[i] <= scrollMid) index = i;
    else break;
  }
  const offset = (scrollMid - pageTops[index]) / pageHeights[index];
  return { page: index + 1, offset: Math.min(1, Math.max(0, offset)) };
}

/** Reading progress as 0–100. The service worker keeps it monotonic. */
export function computePdfPercent(page: number, pageCount: number, offset: number): number {
  if (pageCount <= 0) return 0;
  const percent = Math.round(((page - 1 + offset) / pageCount) * 100);
  return Math.min(100, Math.max(0, percent));
}
