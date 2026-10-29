import { MIN_PAGE_CHARS } from '../../shared/constants';
import type { ReadingPass } from '../../shared/types';

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
