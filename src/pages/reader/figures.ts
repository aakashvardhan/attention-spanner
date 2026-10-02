import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfPosition } from '../../shared/pdf';

/**
 * In-text figure and table mentions ("see Figure 3", "Tab. 2") and where their
 * captions sit, so a click on a mention can jump to the figure.
 */

/** `figure:3` / `table:2` — what a mention and a caption agree on. */
export type FigureKey = string;

const kindOf = (word: string) => (/^tab/i.test(word) ? 'table' : 'figure');

/** Mentions in a run of text: "Figure 3", "Fig. 3", "Figs. 3", "Table 2". */
export const MENTION_RE = /\b(Fig(?:ure)?s?\.?|Tab(?:le)?s?\.?)\s?(\d{1,3})\b/gi;

export function mentionKey(word: string, num: string): FigureKey {
  return `${kindOf(word)}:${Number(num)}`;
}

/**
 * The caption a line opens, if any. A caption starts its line and is followed
 * by a colon, or a full stop and more text — "as shown in\nFigure 3." is a
 * sentence ending, not a caption. `strong` says it used a colon, the
 * unambiguous form, which wins over a full-stop match for the same figure.
 */
export function captionKey(line: string): { key: FigureKey; strong: boolean } | null {
  const m = line.match(/^\s*(Figure|Fig\.?|Table|Tab\.?)\s?(\d{1,3})\s*([:.|])(.*)$/i);
  if (!m) return null;
  const strong = m[3] !== '.';
  if (!strong && m[4].trim().length < 3) return null;
  return { key: mentionKey(m[1], m[2]), strong };
}

interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
}

/**
 * Where each figure/table caption is: its page, and how far down the page
 * (0–1) its first line sits. Walks pdf.js text content line by line.
 */
export async function findFigureCaptions(doc: PDFDocumentProxy): Promise<Map<FigureKey, PdfPosition>> {
  const found = new Map<FigureKey, PdfPosition & { strong: boolean }>();
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    let line = '';
    let lineY: number | null = null;
    const flush = () => {
      const hit = captionKey(line);
      if (hit && lineY !== null) {
        const prev = found.get(hit.key);
        if (!prev || (hit.strong && !prev.strong)) {
          found.set(hit.key, { page: p, offset: Math.min(1, Math.max(0, lineY)), strong: hit.strong });
        }
      }
      line = '';
      lineY = null;
    };
    for (const item of content.items as TextItemLike[]) {
      if (typeof item.str !== 'string') continue;
      if (lineY === null && item.str.trim() && item.transform) {
        const [, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        lineY = y / viewport.height;
      }
      line += item.str;
      if (item.hasEOL) flush();
    }
    flush();
  }
  return new Map([...found].map(([k, { page, offset }]) => [k, { page, offset }]));
}
