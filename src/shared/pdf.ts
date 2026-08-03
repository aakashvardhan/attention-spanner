import { READER_PAGE_PATH } from './constants';
import { parsePaperRef } from './papers';
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

/**
 * Is this response a PDF the browser is about to render in the tab? Covers the
 * PDFs `isPdfUrl` can't see — served from an extensionless URL (allenai.org/
 * papers/…) — by reading the response headers instead of guessing from the path.
 * An `attachment` disposition is a download, not a page: the tab stays where it
 * is, so redirecting it would hijack an unrelated page.
 */
export function isPdfResponse(contentType: string | null, disposition: string | null): boolean {
  if (!contentType || !/^application\/pdf\s*(;|$)/i.test(contentType.trim())) return false;
  return !/(^|;|\s)attachment(\s*;|\s*$)/i.test(disposition ?? '');
}

/** Extension-relative reader URL (path + query); pure so it can be tested. */
export function readerPagePath(pdfUrl: string): string {
  return `${READER_PAGE_PATH}?src=${encodeURIComponent(pdfUrl)}`;
}

/** Absolute chrome-extension:// URL for opening the reader on a PDF. */
export function readerPageUrl(pdfUrl: string): string {
  return chrome.runtime.getURL(readerPagePath(pdfUrl));
}

/** Extension-relative reader URL for a web article (the ?article= kind). */
export function articleReaderPath(url: string): string {
  return `${READER_PAGE_PATH}?article=${encodeURIComponent(url)}`;
}

export function articleReaderUrl(url: string): string {
  return chrome.runtime.getURL(articleReaderPath(url));
}

/** The reader showing a transcript — the third document kind, alongside ?src= and ?article=. */
export function recordingReaderPath(id: string): string {
  return `${READER_PAGE_PATH}?recording=${encodeURIComponent(id)}`;
}

export function recordingReaderUrl(id: string): string {
  return chrome.runtime.getURL(recordingReaderPath(id));
}

/**
 * Should this feed link open in the reader? Only plain http(s) pages: a PDF
 * link goes down the PDF path instead, and anything else (mailto:, a video
 * host) belongs in a normal tab.
 */
/**
 * Hosts that are somewhere you go, not something you read. Extraction on an app
 * shell yields an empty article, so the reader would open on nothing — which is
 * exactly what a bookmark to Gmail or a dashboard used to do once saved links
 * started routing through here.
 */
const APP_HOSTS =
  /^(mail\.google\.com|docs\.google\.com|drive\.google\.com|calendar\.google\.com|meet\.google\.com|notion\.so|x\.com|twitter\.com|github\.com|linkedin\.com)$/;

export function shouldOpenInReader(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  if (isPdfUrl(url)) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    // Video pages are watched, not read — the video tracker handles them
    if (/^(youtube\.com|youtu\.be|vimeo\.com)$/.test(host)) return false;
    return !APP_HOSTS.test(host);
  } catch {
    return false;
  }
}

/**
 * The PDF the reader should load for a paper, or null when we can't name one.
 * Prefers the saved position's URL, then the paper's own link when it's already
 * a PDF, then the arXiv PDF derived from an abs/versioned link — without that
 * last step a paper saved from its abs page could only reach the reader after
 * it had already been read there. Pure, so it's testable without chrome.*.
 */
export function paperPdfSource(paper: Pick<Paper, 'url' | 'pdf'>): string | null {
  if (paper.pdf?.url) return paper.pdf.url;
  if (!paper.url) return null;
  if (isPdfUrl(paper.url)) return paper.url;
  return arxivPdfUrl(paper.url);
}

/**
 * Where "open this paper" should go: the reader (resuming the saved position)
 * whenever we can point it at a PDF, otherwise the paper's own URL.
 */
export function paperOpenUrl(paper: Pick<Paper, 'url' | 'pdf'>): string {
  const pdf = paperPdfSource(paper);
  return pdf ? readerPageUrl(pdf) : paper.url;
}

/**
 * The arXiv PDF URL for a bare id ('2406.09246', 'hep-th/9901001'), or null when
 * the id isn't a recognizable arXiv id. Lets a discovered paper (whose `url` is
 * often an abs page) open straight in the in-extension reader — `isPdfUrl` already
 * recognizes arxiv.org/pdf/ paths, so this feeds `readerPageUrl`.
 */
export function arxivPdfUrl(id: string): string | null {
  const ref = parsePaperRef(id);
  if (!ref?.startsWith('arXiv:')) return null;
  return `https://arxiv.org/pdf/${ref.slice('arXiv:'.length)}`;
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
