import { logActivity } from '../shared/activity';
import { computePdfPercent } from '../shared/pdf';
import { getLocal, setLocal } from '../shared/storage';
import type { Paper } from '../shared/types';

/** Don't rewrite lastReadAt more than once a minute while a paper tab stays open */
const READING_TOUCH_THROTTLE_MS = 60_000;

/**
 * Reading state is the only paper data written here; the paper itself is
 * alphaXiv's (see alphaxiv sync). Writes go through the service worker so two
 * reader tabs never race each other.
 */

export type PaperResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

/** What the PDF reader reports about the position it's showing. */
export interface ReaderPosition {
  pdfUrl: string;
  page: number;
  pageCount: number;
  offset: number;
  /** Outline-derived note ('' when the reader has nothing better than before) */
  leftOff: string;
}

/**
 * Fold a reader position into a paper. Progress only ratchets up, a finished
 * report never lowers it, and the resume position always tracks the latest
 * report. Pure (mutates and returns whether anything changed) so it's testable
 * without storage.
 */
export function applyReaderProgress(paper: Paper, pos: ReaderPosition, now: number): boolean {
  const pageCount = Math.max(1, Math.round(pos.pageCount));
  const page = Math.min(pageCount, Math.max(1, Math.round(pos.page)));
  // Rounded so near-identical scroll reports don't churn updatedAt (and sync)
  const offset = Math.round(Math.min(1, Math.max(0, pos.offset)) * 1000) / 1000;

  let changed = false;
  const prev = paper.pdf;
  if (
    !prev ||
    prev.url !== pos.pdfUrl ||
    prev.page !== page ||
    prev.pageCount !== pageCount ||
    prev.offset !== offset
  ) {
    paper.pdf = { url: pos.pdfUrl, page, pageCount, offset };
    changed = true;
  }

  const percent = computePdfPercent(page, pageCount, offset);
  if (percent > paper.progressPercent) {
    paper.progressPercent = percent;
    changed = true;
  }

  const leftOff = pos.leftOff.trim();
  if (leftOff && leftOff !== paper.leftOff) {
    paper.leftOff = leftOff;
    changed = true;
  }

  if (!paper.lastReadAt || now - paper.lastReadAt > READING_TOUCH_THROTTLE_MS) {
    paper.lastReadAt = now;
    changed = true;
  }

  if (changed) paper.updatedAt = now;
  return changed;
}

export async function handleReaderProgress(
  paperId: string,
  pos: ReaderPosition,
): Promise<PaperResult> {
  const { papers } = await getLocal('papers');
  const paper = papers.find((p) => p.id === paperId);
  if (!paper) return { ok: false, error: 'Paper not found.' };
  const now = Date.now();
  if (applyReaderProgress(paper, pos, now)) await setLocal({ papers });
  if (paper.lastReadAt === now) await logActivity({ paperId });
  return { ok: true };
}
