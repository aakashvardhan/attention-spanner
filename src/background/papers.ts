import { MAX_PAPERS } from '../shared/constants';
import { paperMatchKey } from '../shared/papers';
import { computePdfPercent } from '../shared/pdf';
import { getLocal, setLocal } from '../shared/storage';
import { newPaper } from '../shared/sync/recordShapes';
import type { Paper, PaperDraft } from '../shared/types';

/** Don't rewrite lastReadAt more than once a minute while a paper tab stays open */
const READING_TOUCH_THROTTLE_MS = 60_000;

/**
 * All paper writes happen here in the service worker so the papers page and the
 * dashboard card never race each other (same pattern as bookmarks/flashcards).
 */

export type PaperResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

export async function addPaper(draft: PaperDraft): Promise<PaperResult<{ paper: Paper }>> {
  const { papers, decks } = await getLocal('papers', 'decks');
  if (papers.length >= MAX_PAPERS) {
    return { ok: false, error: `Paper limit reached (${MAX_PAPERS}).` };
  }
  if (!decks.some((d) => d.id === draft.deckId)) {
    return { ok: false, error: 'Pick a deck first.' };
  }
  if (!draft.title.trim()) return { ok: false, error: 'A title is required.' };

  const paper = newPaper(draft, Date.now(), crypto.randomUUID());
  await setLocal({ papers: [...papers, paper] });
  return { ok: true, paper };
}

export async function updatePaper(
  id: string,
  patch: Partial<PaperDraft>,
): Promise<PaperResult> {
  const { papers } = await getLocal('papers');
  const paper = papers.find((p) => p.id === id);
  if (!paper) return { ok: false, error: 'Paper not found.' };

  Object.assign(paper, patch);
  paper.updatedAt = Date.now();
  // Reading a paper (setting/advancing progress while not "to-read") stamps the
  // last-read time so the dashboard can surface the most recently touched ones.
  const touchesReading = patch.status !== undefined || patch.progressPercent !== undefined;
  if (touchesReading && paper.status !== 'to-read') paper.lastReadAt = Date.now();

  await setLocal({ papers });
  return { ok: true };
}

export async function deletePaper(id: string): Promise<PaperResult> {
  const { papers } = await getLocal('papers');
  await setLocal({ papers: papers.filter((p) => p.id !== id) });
  return { ok: true };
}

/**
 * When a browser tab shows a tracked paper's URL, treat it as "currently
 * reading": promote a to-read paper to reading and refresh its last-read time.
 * Only the URL is needed, so this works even in Chrome's PDF viewer or a
 * third-party reader (e.g. Google Scholar PDF Reader) that our content scripts
 * can't reach. A finished ('read') paper is left alone.
 */
export async function markPaperReadingByUrl(url: string): Promise<void> {
  const key = paperMatchKey(url);
  if (!key) return;
  const { papers } = await getLocal('papers');
  const paper = papers.find((p) => paperMatchKey(p.url) === key);
  if (!paper || paper.status === 'read') return;

  const now = Date.now();
  let changed = false;
  if (paper.status === 'to-read') {
    paper.status = 'reading';
    changed = true;
  }
  if (!paper.lastReadAt || now - paper.lastReadAt > READING_TOUCH_THROTTLE_MS) {
    paper.lastReadAt = now;
    changed = true;
  }
  if (changed) {
    paper.updatedAt = now;
    await setLocal({ papers });
  }
}

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
 * paper is never demoted, and the resume position always tracks the latest
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

  if (paper.status === 'to-read') {
    paper.status = 'reading';
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
  if (applyReaderProgress(paper, pos, Date.now())) await setLocal({ papers });
  return { ok: true };
}
