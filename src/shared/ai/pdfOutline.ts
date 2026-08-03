import { NANO_INPUT_BUDGET_CHARS, PDF_QA_CLOUD_MAX_CHARS } from '../constants';
import { hash32 } from './cache';
import { cloudProviderFor, hasCloudKey } from './cloud';
import { newTurn } from './assistantTypes';
import { nanoProvider } from './nanoProvider';
import { getLocal, setLocal } from '../storage';
import type { FlatOutlineItem } from '../pdfOutline';
import type { Settings } from '../types';

export interface AiOutlineItem {
  title: string;
  /** Exact nesting depth from the PDF outline, or the detected heading depth. */
  level: number;
  /** An extractive, source-verifiable passage rather than model-authored prose. */
  summary: string;
  page: number;
}

interface ModelOutlineItem {
  title: string;
  summary: string;
  evidence: string;
  page: number;
  level: number;
}

const schema = {
  type: 'object',
  properties: {
    outline: {
      type: 'array', maxItems: 24,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          evidence: { type: 'string' },
          page: { type: 'number' },
          level: { type: 'number' },
        },
        required: ['title', 'summary', 'evidence', 'page', 'level'],
      },
    },
  },
  required: ['outline'],
};

const OUTLINE_CACHE_VERSION = 2;
const OUTLINE_CACHE_MAX_ENTRIES = 30;
const pending = new Map<string, Promise<AiOutlineItem[]>>();

/** Content identity changes when the extracted PDF changes, not when its URL changes. */
export function pdfOutlineCacheKey(pageTexts: string[]): string {
  const content = pageTexts.join('\u241e');
  return `pdf-outline:v${OUTLINE_CACHE_VERSION}:${pageTexts.length}:${content.length}:${hash32(content)}`;
}

function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function sourceExcerpt(
  source: string,
  candidate: string,
  minimumLength = 20,
): string | null {
  const needle = normalized(candidate);
  if (needle.length < minimumLength) return null;
  const words = needle.split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const match = source.match(new RegExp(words.join('[^\\p{L}\\p{N}]+'), 'iu'));
  if (!match || match.index === undefined) return null;
  let excerpt = match[0];
  let end = match.index + match[0].length;
  // Preserve sentence punctuation from the PDF, without accepting punctuation
  // supplied by the model or consuming the next word.
  while (end < source.length && /[^\p{L}\p{N}\s]/u.test(source[end])) {
    excerpt += source[end];
    end += 1;
  }
  return excerpt.trim() || null;
}

function matchBookmark(
  title: string,
  page: number,
  level: number,
  bookmarks: FlatOutlineItem[],
): FlatOutlineItem | undefined {
  const wanted = normalized(title);
  return bookmarks.find(
    (item) =>
      normalized(item.title) === wanted &&
      item.page === page &&
      item.level === level,
  );
}

/**
 * Reject anything that cannot be traced to the claimed page. The displayed
 * description is the exact evidence passage, never the model-authored summary.
 */
export function groundPdfOutline(
  raw: unknown,
  pageTexts: string[],
  bookmarks: FlatOutlineItem[] = [],
): AiOutlineItem[] {
  if (!Array.isArray(raw)) return [];
  const grounded: AiOutlineItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Partial<ModelOutlineItem>;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const evidence = typeof item.evidence === 'string' ? item.evidence.trim() : '';
    const page = typeof item.page === 'number' ? Math.round(item.page) : 0;
    const level = typeof item.level === 'number' ? Math.max(0, Math.round(item.level)) : 0;
    if (!title || page < 1 || page > pageTexts.length) continue;
    const pageText = pageTexts[page - 1] ?? '';
    const verifiedEvidence = sourceExcerpt(pageText, evidence);
    if (!verifiedEvidence) continue;

    const bookmark = bookmarks.length
      ? matchBookmark(title, page, level, bookmarks)
      : undefined;
    // With bookmarks, their exact title/page/depth is authoritative. Without
    // bookmarks, a heading must still occur verbatim on its claimed page.
    if (bookmarks.length && !bookmark) continue;
    const verifiedTitle = bookmarks.length ? null : sourceExcerpt(pageText, title, 3);
    if (!bookmarks.length && !verifiedTitle) continue;

    const sourceTitle = bookmark?.title ?? verifiedTitle ?? title;
    const key = `${page}:${level}:${normalized(sourceTitle)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    grounded.push({ title: sourceTitle, level, summary: verifiedEvidence.slice(0, 600), page });
  }
  return grounded.sort((a, b) => a.page - b.page || a.level - b.level);
}

function contextFor(pageTexts: string[], budget: number): string {
  // Preserve coverage of the whole paper instead of silently cutting off the
  // latter sections. Page markers remain intact for grounded page links.
  const perPage = Math.max(1, Math.floor(budget / Math.max(1, pageTexts.length)) - 24);
  return pageTexts
    .map((text, index) => `\n[Page ${index + 1}]\n${text.slice(0, perPage)}`)
    .join('')
    .slice(0, budget);
}

/** Generate a skimmable, page-linked outline from extracted PDF text. */
export async function generatePdfOutline(opts: {
  title: string;
  pageTexts: string[];
  bookmarks?: FlatOutlineItem[];
  settings: Settings;
  nanoOk: boolean;
}): Promise<AiOutlineItem[]> {
  const cloudOk = hasCloudKey(opts.settings);
  if (!opts.nanoOk && !cloudOk) throw new Error('Enable on-device AI or add a cloud API key to generate an AI outline.');
  const fullLength = opts.pageTexts.reduce((sum, text) => sum + text.length + 18, 0);
  const useCloud = !opts.nanoOk || (cloudOk && fullLength > NANO_INPUT_BUDGET_CHARS);
  const budget = useCloud ? PDF_QA_CLOUD_MAX_CHARS : NANO_INPUT_BUDGET_CHARS;
  const text = contextFor(opts.pageTexts, budget);
  const provider = useCloud ? cloudProviderFor(opts.settings) : nanoProvider;
  const bookmarks = opts.bookmarks ?? [];
  const bookmarkContext = bookmarks.length
    ? `\nAuthoritative PDF outline (copy title, page, and level exactly):\n${JSON.stringify(bookmarks.slice(0, 80))}`
    : '\nThis PDF has no embedded outline. Use only headings that appear verbatim in the page text.';
  const reply = await provider.generate({
    system: [
      'Create a concise, hierarchical outline of a research paper using only the supplied PDF text.',
      'Return 5–24 entries in reading order.',
      'For every entry, evidence must be an exact, contiguous passage copied from the claimed page (at least 20 characters).',
      'Never infer a result, method, heading, or claim that is not explicit in that passage.',
      'The summary can be concise, but it is used only for internal review; the UI displays the verified evidence passage.',
      bookmarks.length
        ? 'The supplied PDF outline is authoritative. Copy each selected title, page, and level exactly; do not rename, merge, or invent sections.'
        : 'Copy each title exactly from a heading visible in the claimed page text and infer only its nesting level.',
    ].join(' '),
    turns: [newTurn('user', `Paper: ${opts.title}${bookmarkContext}\n\nPDF text:${text}`)],
    responseSchema: schema,
  });
  let parsed: { outline?: unknown };
  try {
    // Gemini/Nano honor the schema; cloud providers that do not may still
    // wrap valid JSON in a Markdown fence.
    const json = reply.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    parsed = JSON.parse(json) as { outline?: unknown };
  } catch { throw new Error('The AI returned an unreadable outline. Try again.'); }
  if (!Array.isArray(parsed.outline)) throw new Error('The AI did not return an outline. Try again.');
  const grounded = groundPdfOutline(parsed.outline, opts.pageTexts, bookmarks);
  if (!grounded.length) {
    throw new Error('No source-verified outline could be created from this PDF.');
  }
  return grounded;
}

export async function getCachedPdfOutline(pageTexts: string[]): Promise<AiOutlineItem[] | null> {
  const key = pdfOutlineCacheKey(pageTexts);
  const { pdfOutlineCache } = await getLocal('pdfOutlineCache');
  const hit = pdfOutlineCache[key];
  if (!hit?.items.length) return null;
  // Best-effort LRU touch. A failed storage write must not turn a cache hit into
  // a failed reader experience.
  void setLocal({
    pdfOutlineCache: {
      ...pdfOutlineCache,
      [key]: { ...hit, lastAccessedAt: Date.now() },
    },
  }).catch(() => undefined);
  return hit.items;
}

async function storePdfOutline(pageTexts: string[], items: AiOutlineItem[]): Promise<void> {
  const key = pdfOutlineCacheKey(pageTexts);
  const { pdfOutlineCache } = await getLocal('pdfOutlineCache');
  const now = Date.now();
  const entries = Object.entries(pdfOutlineCache)
    .filter(([entryKey]) => entryKey !== key)
    .sort((a, b) => b[1].lastAccessedAt - a[1].lastAccessedAt)
    .slice(0, OUTLINE_CACHE_MAX_ENTRIES - 1);
  await setLocal({
    pdfOutlineCache: {
      ...Object.fromEntries(entries),
      [key]: { items, createdAt: now, lastAccessedAt: now },
    },
  });
}

export async function getOrGeneratePdfOutline(
  opts: Parameters<typeof generatePdfOutline>[0],
  force = false,
): Promise<{ items: AiOutlineItem[]; cached: boolean }> {
  const key = pdfOutlineCacheKey(opts.pageTexts);
  if (!force) {
    const cached = await getCachedPdfOutline(opts.pageTexts);
    if (cached) return { items: cached, cached: true };
  }
  const existing = pending.get(key);
  if (existing) return { items: await existing, cached: false };
  const request = generatePdfOutline(opts).then(async (items) => {
    await storePdfOutline(opts.pageTexts, items);
    return items;
  });
  pending.set(key, request);
  try {
    return { items: await request, cached: false };
  } finally {
    if (pending.get(key) === request) pending.delete(key);
  }
}
