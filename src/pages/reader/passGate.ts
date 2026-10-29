import { MIN_PAGE_CHARS } from '../../shared/constants';
import { XP } from '../../shared/thinking';
import type { Provocation, ReadingPass } from '../../shared/types';

// A line needs at least one STRONG char (operator or Greek); WEAK ones only add weight.
const STRONG = /[=≤≥≈≠±×÷∑∏∫∂∇√∞∈∉⊂⊆∪∩∀∃→←↔⇒‖α-ωΑ-Ω]/g;
const WEAK = /[<>^_{}|]/g;

/** First "Algorithm N" block, or line with ≥8 math/Greek chars making ≥25% of its non-space chars; ≤400 chars; '' if none */
export function mathBlock(pageText: string): string {
  const alg = /^\s*Algorithm\s+\d+/m.exec(pageText);
  if (alg) return pageText.slice(alg.index, alg.index + 400);
  for (const line of pageText.split('\n')) {
    const flat = line.replace(/\s/g, '');
    const strong = flat.match(STRONG)?.length ?? 0;
    const n = strong + (flat.match(WEAK)?.length ?? 0);
    if (strong >= 1 && n >= 8 && n / flat.length >= 0.25) return line.trim().slice(0, 400);
  }
  return '';
}

export function shouldLock(o: {
  pass: ReadingPass;
  pageText: string;
  section: number;
  lockedSections: ReadonlySet<number>;
  openOnPage: boolean;
}): boolean {
  if (o.pass !== 3 || o.pageText.length < MIN_PAGE_CHARS) return false;
  return mathBlock(o.pageText) !== '' || o.openOnPage || !o.lockedSections.has(o.section);
}

/**
 * Pass 3 locks the page being left: settling forward from `left` into a later
 * page asks whether `left` needed justifying. The first settle (left null, the
 * page you open on) never locks, and neither does going back.
 */
export function pageToLock(o: {
  left: number | null;
  page: number;
  pass: ReadingPass;
  pageTexts: readonly string[];
  sectionOf: (page: number) => number;
  lockedSections: ReadonlySet<number>;
  /** Pages already justified (this session, or by a stored answer) */
  justified: ReadonlySet<number>;
  /** Pages with an open or unsure record */
  openPages: ReadonlySet<number>;
}): number | null {
  const { left } = o;
  if (left === null || o.page <= left || o.justified.has(left)) return null;
  const locks = shouldLock({
    pass: o.pass,
    pageText: o.pageTexts[left - 1] ?? '',
    section: o.sectionOf(left),
    lockedSections: o.lockedSections,
    openOnPage: o.openPages.has(left),
  });
  return locks ? left : null;
}

/**
 * Pages of this document a stored answer already justifies: an answered lock,
 * or an open record later resolved (it earned the resolve XP, as a lock answer
 * does). A reopened paper does not lock them again.
 */
export function justifiedPages(records: readonly Provocation[], docKey: string): Set<number> {
  const pages = new Set<number>();
  for (const p of records) {
    if (p.docKey !== docKey || p.status !== 'answered') continue;
    const resolved = p.kind !== 'counterpoint' && p.kind !== 'verdict' && p.xp === XP.resolve;
    if (p.kind === 'lock' || resolved) pages.add(p.page);
  }
  return pages;
}
