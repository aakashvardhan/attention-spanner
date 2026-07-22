/**
 * Article extraction: HTML in, ordered reading blocks out.
 *
 * Same heuristics the assistant's page-content grab has used since Phase 16
 * (prefer <article>/<main>, strip chrome) — but structured rather than
 * flattened, because the reader needs headings for its outline and stable
 * block indexes for text anchors, not one long string.
 *
 * Takes a Document so it is testable with any DOMParser and works both in the
 * reader page (parsing fetched HTML) and against the live DOM.
 */

export type BlockKind = 'heading' | 'para' | 'quote' | 'code' | 'list';

export interface ArticleBlock {
  kind: BlockKind;
  text: string;
  /** Heading depth 1-6; 0 for everything else */
  level: number;
}

export interface ExtractedArticle {
  title: string;
  blocks: ArticleBlock[];
}

/** Page furniture that is never article content. */
const STRIP = 'nav, header, footer, aside, script, style, noscript, iframe, form, button, svg, figure figcaption, .ad, [aria-hidden="true"]';

/** Shorter than this and a block is almost certainly a label, not prose. */
const MIN_PARA_CHARS = 24;

const BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, blockquote, pre, li';

/*
 * The DOM walk below is a thin loop; every judgement it makes lives in these
 * pure helpers so it can be unit-tested without pulling in a DOM
 * implementation. The walk itself is covered by the browser end-to-end run
 * against demo/article.html.
 */

export function clean(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function kindOf(tag: string): BlockKind {
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'blockquote') return 'quote';
  if (tag === 'pre') return 'code';
  if (tag === 'li') return 'list';
  return 'para';
}

/** Is this cleaned block worth keeping? Short bare paragraphs are labels. */
export function keepBlock(kind: BlockKind, text: string): boolean {
  if (!text) return false;
  return kind !== 'para' || text.length >= MIN_PARA_CHARS;
}

export function titleFrom(
  docTitle: string,
  blocks: readonly ArticleBlock[],
  fallback: string,
): string {
  const h1 = blocks.find((b) => b.kind === 'heading' && b.level === 1);
  return clean(docTitle) || h1?.text || fallback;
}

/** Headings become the reader's outline; body blocks are not navigable. */
export function outlineOf(
  blocks: readonly ArticleBlock[],
): { title: string; level: number; blockIndex: number }[] {
  return blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.kind === 'heading')
    .map(({ b, i }) => ({ title: b.text, level: b.level, blockIndex: i }));
}

/**
 * Pick the subtree most likely to be the article. <article>/<main> when
 * present, else the element with the most paragraph text — a crude density
 * heuristic, but it beats <body> on sites that wrap content in bare divs.
 */
export function pickRoot(doc: Document): Element {
  const explicit = doc.querySelector('article') ?? doc.querySelector('main');
  if (explicit) return explicit;

  let best: { el: Element; score: number } | null = null;
  for (const el of Array.from(doc.querySelectorAll('div, section'))) {
    const score = Array.from(el.querySelectorAll('p')).reduce(
      (n, p) => n + (p.textContent ?? '').length,
      0,
    );
    if (!best || score > best.score) best = { el, score };
  }
  return best && best.score > 0 ? best.el : doc.body;
}

export function extractArticle(doc: Document, fallbackTitle = ''): ExtractedArticle {
  const root = pickRoot(doc).cloneNode(true) as Element;
  for (const el of Array.from(root.querySelectorAll(STRIP))) el.remove();

  const blocks: ArticleBlock[] = [];
  const seen = new Set<string>();

  for (const el of Array.from(root.querySelectorAll(BLOCK_SELECTOR))) {
    // A <p> inside a <blockquote> would otherwise be emitted twice
    if (el.parentElement?.closest('blockquote, pre, li') && el.tagName.toLowerCase() === 'p') {
      continue;
    }
    const tag = el.tagName.toLowerCase();
    const kind = kindOf(tag);
    const text = clean(el.textContent ?? '');
    if (!keepBlock(kind, text)) continue;

    // Boilerplate repeated verbatim (share prompts, cookie lines) adds nothing
    const dedupeKey = `${kind}:${text}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    blocks.push({ kind, text, level: kind === 'heading' ? Number(tag[1]) : 0 });
  }

  return { title: titleFrom(doc.title, blocks, fallbackTitle), blocks };
}

/** The plain-text form the AI panels and the library index consume. */
export function articleText(blocks: readonly ArticleBlock[]): string {
  return blocks.map((b) => b.text).join('\n\n');
}
