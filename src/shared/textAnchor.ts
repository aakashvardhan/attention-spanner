/**
 * Text anchoring for article annotations (W3C TextQuoteSelector, pared down).
 *
 * A PDF highlight can store page rectangles because a PDF page is a fixed box.
 * An article reflows, so the same rectangles stop meaning anything the moment
 * the window resizes or the site changes its markup. Instead we store the
 * quote plus a little surrounding context and find it again at load time.
 *
 * Pure — no DOM. The reader maps the returned offsets back onto rendered
 * blocks.
 */

/** Context captured either side of a quote to disambiguate repeated text. */
export const TEXT_ANCHOR_CONTEXT_CHARS = 32;

export interface TextAnchor {
  blockIndex: number;
  quote: string;
  prefix: string;
  suffix: string;
}

export interface AnchorHit {
  blockIndex: number;
  /** Character offset of the quote within that block's text */
  start: number;
  end: number;
}

/** Build an anchor from a selection inside one block. */
export function makeTextAnchor(
  blocks: readonly string[],
  blockIndex: number,
  start: number,
  end: number,
): TextAnchor | null {
  const text = blocks[blockIndex];
  if (text === undefined) return null;
  const quote = text.slice(start, end);
  if (!quote.trim()) return null;
  return {
    blockIndex,
    quote,
    prefix: text.slice(Math.max(0, start - TEXT_ANCHOR_CONTEXT_CHARS), start),
    suffix: text.slice(end, end + TEXT_ANCHOR_CONTEXT_CHARS),
  };
}

/** How well a candidate position matches the anchor's remembered context. */
function contextScore(text: string, start: number, end: number, anchor: TextAnchor): number {
  const before = text.slice(Math.max(0, start - TEXT_ANCHOR_CONTEXT_CHARS), start);
  const after = text.slice(end, end + TEXT_ANCHOR_CONTEXT_CHARS);
  return commonSuffix(before, anchor.prefix) + commonPrefix(after, anchor.suffix);
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/** Every occurrence of `quote` in `text`. */
function occurrences(text: string, quote: string): number[] {
  const out: number[] = [];
  if (!quote) return out;
  let from = 0;
  for (;;) {
    const at = text.indexOf(quote, from);
    if (at === -1) return out;
    out.push(at);
    from = at + 1;
  }
}

/**
 * Find the anchor in the current blocks.
 *
 * The remembered blockIndex is only a hint: blocks shift when a site adds a
 * paragraph, so a miss there falls back to scanning every block. Among
 * candidates, the one whose surrounding text best matches the remembered
 * prefix/suffix wins, with the hinted block breaking ties. Returns null when
 * the quote is simply gone — the caller drops the highlight rather than
 * anchoring it somewhere wrong.
 */
export function findTextAnchor(blocks: readonly string[], anchor: TextAnchor): AnchorHit | null {
  let best: (AnchorHit & { score: number }) | null = null;

  const consider = (blockIndex: number) => {
    const text = blocks[blockIndex];
    if (text === undefined) return;
    for (const start of occurrences(text, anchor.quote)) {
      const end = start + anchor.quote.length;
      let score = contextScore(text, start, end, anchor);
      // Tie-break toward where the annotation was originally made
      if (blockIndex === anchor.blockIndex) score += 0.5;
      if (!best || score > best.score) best = { blockIndex, start, end, score };
    }
  };

  consider(anchor.blockIndex);
  // A perfect context match at the hinted block needs no wider search
  const ceiling = 2 * TEXT_ANCHOR_CONTEXT_CHARS + 0.5;
  if (best && (best as AnchorHit & { score: number }).score >= ceiling) {
    const { blockIndex, start, end } = best;
    return { blockIndex, start, end };
  }

  for (let i = 0; i < blocks.length; i++) {
    if (i !== anchor.blockIndex) consider(i);
  }

  if (!best) return null;
  const { blockIndex, start, end } = best;
  return { blockIndex, start, end };
}
