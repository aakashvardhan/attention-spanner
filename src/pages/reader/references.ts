import type { PDFDocumentProxy } from 'pdfjs-dist';

/** A single bibliography entry, resolved from a citation marker. */
export interface Reference {
  /** Numeric label when the list is numbered ("12"); null for author-year lists. */
  label: string | null;
  /** Full entry text — this is what the tooltip shows as the reference "name". */
  text: string;
  /** Best-effort link derived from the entry (arXiv/DOI/URL), or null. */
  link: string | null;
  /** First-author surname, lowercased — for author-year matching. */
  authorKey: string | null;
  /** 4-digit year — for author-year matching. */
  year: number | null;
}

export interface ReferenceIndex {
  byLabel: Map<string, Reference>;
  /** Keyed `${surname}|${year}`, both lowercased. */
  byAuthorYear: Map<string, Reference>;
  isEmpty: boolean;
}

const EMPTY_INDEX: ReferenceIndex = { byLabel: new Map(), byAuthorYear: new Map(), isEmpty: true };

/** pdf.js text items; marked-content items have no `str` and are skipped. */
interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
}

/**
 * Pull an openable link out of a raw bibliography entry. Prefers a canonical
 * arXiv abstract link, then a DOI, then any bare URL. Kept separate from
 * `parsePaperRef` (which anchors its arXiv regex, so a bare id inside a longer
 * string won't match) — here the id sits amid author/title text.
 */
export function extractRefLink(text: string): string | null {
  // arXiv: an arxiv.org URL, or an `arXiv:<id>` token (new or legacy style).
  const arxivUrl = text.match(/arxiv\.org\/(?:abs|pdf)\/([^\s,;)\]]+)/i);
  if (arxivUrl) {
    const id = arxivUrl[1].replace(/\.pdf$/i, '').replace(/v\d+$/i, '');
    return `https://arxiv.org/abs/${id}`;
  }
  const arxivId = text.match(
    /arxiv[:\s]+((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(?:v\d+)?/i,
  );
  if (arxivId) return `https://arxiv.org/abs/${arxivId[1]}`;

  // DOI: bare or in a doi.org URL. Trim trailing sentence punctuation.
  const doi = text.match(/\b(10\.\d{4,9}\/[^\s,;)\]]+)/i);
  if (doi) return `https://doi.org/${doi[1].replace(/[.,;]+$/, '')}`;

  // Any other link.
  const url = text.match(/https?:\/\/[^\s,;)\]]+/i);
  if (url) return url[0].replace(/[.,;]+$/, '');

  return null;
}

const YEAR_RE = /\b(19|20)\d{2}\b/;
const SURNAME_RE = /^([A-Z][A-Za-z'’-]+)/;

function makeReference(label: string | null, text: string): Reference | null {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length < 8) return null; // too short to be a real entry
  const yearMatch = clean.match(YEAR_RE);
  const surname = clean.match(SURNAME_RE);
  return {
    label,
    text: clean,
    link: extractRefLink(clean),
    authorKey: surname ? surname[1].toLowerCase() : null,
    year: yearMatch ? Number(yearMatch[0]) : null,
  };
}

function indexReferences(refs: Reference[]): ReferenceIndex {
  const byLabel = new Map<string, Reference>();
  const byAuthorYear = new Map<string, Reference>();
  for (const ref of refs) {
    if (ref.label !== null) byLabel.set(ref.label, ref);
    if (ref.authorKey && ref.year !== null) {
      // First writer wins so the earliest (usually correct) entry keeps the key.
      const key = `${ref.authorKey}|${ref.year}`;
      if (!byAuthorYear.has(key)) byAuthorYear.set(key, ref);
    }
  }
  return { byLabel, byAuthorYear, isEmpty: refs.length === 0 };
}

/**
 * Parse the bibliography out of a document's full text. Locates the References
 * section, detects the numbering style ([n], n., or unnumbered author-year),
 * and splits it into entries. Pure and string-based so it can be unit-tested.
 */
export function parseBibliography(fullText: string): ReferenceIndex {
  const lines = fullText.split('\n');

  // Find the References/Bibliography heading: the last standalone such line
  // (searching from the back skips any in-body mention or table-of-contents
  // entry, which wouldn't be a bare heading line anyway).
  let headingIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*(?:\d+\.?\s+)?(references|bibliography)\s*$/i.test(lines[i])) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1 || headingIdx === lines.length - 1) return EMPTY_INDEX;

  const body = lines.slice(headingIdx + 1);
  const joined = body.join(' ');

  // Bracketed [n] — the most reliable to split on.
  if (/\[\d{1,3}\]/.test(joined)) {
    const parts = joined.split(/\[(\d{1,3})\]/);
    const refs: Reference[] = [];
    // parts[0] is any preamble; then [label, body, label, body, ...].
    for (let i = 1; i < parts.length - 1; i += 2) {
      const ref = makeReference(parts[i], parts[i + 1]);
      if (ref) refs.push(ref);
    }
    if (refs.length) return indexReferences(refs);
  }

  // Numbered "n." at line starts — require sequential numbering so a stray
  // "vol. 3." mid-entry doesn't start a new one.
  const dotStarts = body.filter((l) => /^\s*\d{1,3}\.\s+\S/.test(l)).length;
  if (dotStarts >= 3) {
    const refs: Reference[] = [];
    let expected = 1;
    let current: string[] = [];
    let currentLabel = '';
    for (const line of body) {
      const m = line.match(/^\s*(\d{1,3})\.\s+(.*)$/);
      if (m && Number(m[1]) === expected) {
        if (current.length) {
          const ref = makeReference(currentLabel, current.join(' '));
          if (ref) refs.push(ref);
        }
        currentLabel = m[1];
        current = [m[2]];
        expected += 1;
      } else if (current.length) {
        current.push(line);
      }
    }
    if (current.length) {
      const ref = makeReference(currentLabel, current.join(' '));
      if (ref) refs.push(ref);
    }
    if (refs.length) return indexReferences(refs);
  }

  // Unnumbered author-year: a "Surname," at a line start begins an entry.
  const refs: Reference[] = [];
  let current: string[] = [];
  for (const line of body) {
    if (/^[A-Z][A-Za-z'’-]+,/.test(line.trim())) {
      if (current.length) {
        const ref = makeReference(null, current.join(' '));
        if (ref) refs.push(ref);
      }
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) {
    const ref = makeReference(null, current.join(' '));
    if (ref) refs.push(ref);
  }
  return indexReferences(refs);
}

/** Read the full text of every page, reconstructing line breaks from `hasEOL`. */
async function readFullText(doc: PDFDocumentProxy): Promise<string> {
  let out = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items as TextItemLike[]) {
      if (typeof item.str !== 'string') continue;
      out += item.str;
      if (item.hasEOL) out += '\n';
    }
    out += '\n';
  }
  return out;
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

/**
 * The URL to open for a reference: its own extracted link, or a Semantic
 * Scholar title search over the entry text as a fallback.
 */
export function citationHref(ref: Reference): string {
  return (
    ref.link ??
    `https://www.semanticscholar.org/search?q=${encodeURIComponent(ref.text)}&sort=relevance`
  );
}

/** Resolve a hovered citation marker to its bibliography entries. */
export function resolveCitation(
  index: ReferenceIndex,
  marker: { labels?: string[]; author?: string; year?: number },
): Reference[] {
  if (marker.labels?.length) {
    const seen = new Set<string>();
    const out: Reference[] = [];
    for (const label of marker.labels) {
      const ref = index.byLabel.get(label);
      if (ref && !seen.has(label)) {
        seen.add(label);
        out.push(ref);
      }
    }
    return out;
  }
  if (marker.author && marker.year !== undefined) {
    const ref = index.byAuthorYear.get(`${marker.author.toLowerCase()}|${marker.year}`);
    return ref ? [ref] : [];
  }
  return [];
}
