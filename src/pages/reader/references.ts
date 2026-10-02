import type { PDFDocumentProxy } from 'pdfjs-dist';
import { EMPTY_INDEX, parseBibliography, type ReferenceIndex } from '../../shared/bibliography';

/**
 * The pdf.js half of reference handling: getting a document's text out, and
 * caching it. The parsing itself lives in shared/bibliography.ts, because the
 * service worker needs it too and cannot import a page module.
 *
 * Re-exported below so every existing caller keeps its import path.
 */

export {
  allReferences,
  citationHref,
  extractRefLink,
  parseBibliography,
  resolveCitation,
  type Reference,
  type ReferenceIndex,
} from '../../shared/bibliography';

/** pdf.js text items; marked-content items have no `str` and are skipped. */
interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
}

/** Text split by page: useful for deterministic Find and scan detection. */
export async function getPdfPageTexts(doc: PDFDocumentProxy): Promise<string[]> {
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items as TextItemLike[]) {
      if (typeof item.str !== 'string') continue;
      text += item.str;
      if (item.hasEOL) text += '\n';
    }
    pages.push(text);
  }
  return pages;
}

/** Read the full text of every page, reconstructing line breaks from `hasEOL`. */
async function readFullText(doc: PDFDocumentProxy): Promise<string> {
  return (await getPdfPageTexts(doc)).join('\n');
}

/**
 * Cached full-text retrieval. Extracts each document's text once and shares the
 * result across callers — the bibliography indexer and the reader's Q&A panel
 * both need it, and re-opening the Ask panel shouldn't re-walk every page. Keyed
 * by the pdf.js document through a WeakMap, so the entry evicts on its own when
 * the document is dropped (loading a new `src` produces a fresh document). A
 * rejected extraction is not cached, so a transient failure can be retried.
 */
const textCache = new WeakMap<PDFDocumentProxy, Promise<string>>();

export function getPdfText(doc: PDFDocumentProxy): Promise<string> {
  let pending = textCache.get(doc);
  if (!pending) {
    pending = readFullText(doc).catch((err) => {
      textCache.delete(doc);
      throw err;
    });
    textCache.set(doc, pending);
  }
  return pending;
}

/** Extract the reference index for a document. Non-blocking to run after paint. */
export async function extractReferences(doc: PDFDocumentProxy): Promise<ReferenceIndex> {
  try {
    return parseBibliography(await getPdfText(doc));
  } catch {
    return EMPTY_INDEX;
  }
}
