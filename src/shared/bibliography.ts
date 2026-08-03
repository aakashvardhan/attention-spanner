/**
 * Parsing a reference list out of a document's text. Pure and string-based —
 * no pdf.js, no DOM — so it runs in the service worker too.
 *
 * Three callers depend on this one parser, which is why it lives here rather
 * than beside the reader that first needed it: the PDF reader's citation
 * previews, the citation source that reads a paper's own bibliography, and the
 * alphaXiv source, which fetches a paper's full text and hands it straight in.
 */

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
  /**
   * Every entry, in the order the document lists them.
   *
   * Separate from the lookup maps on purpose. Those answer "which entry does
   * this citation marker mean", and an entry only lands in them if it has
   * something to be looked up *by* — a label, or a surname and a year. The
   * reader's reference list has a different job: show what the paper cites,
   * all of it. Rebuilding that list from the maps quietly dropped every entry
   * that happened not to be resolvable.
   */
  entries: Reference[];
  byLabel: Map<string, Reference>;
  /** Keyed `${surname}|${year}`, both lowercased. */
  byAuthorYear: Map<string, Reference>;
  isEmpty: boolean;
}

export const EMPTY_INDEX: ReferenceIndex = {
  entries: [],
  byLabel: new Map(),
  byAuthorYear: new Map(),
  isEmpty: true,
};

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
    // Trailing punctuation is the sentence's, not the identifier's. A
    // bibliography entry ends in a full stop and the URL is usually the last
    // thing in it, so without this the link becomes `…/abs/2412.07755.` —
    // which arXiv rejects outright, and which no longer parses back into an
    // arXiv id either. The DOI and bare-URL branches below already trim; this
    // one is the one that did not. Order matters: strip the sentence's
    // punctuation before `.pdf`, or `…/1706.03762.pdf).` keeps its extension.
    const id = arxivUrl[1]
      .replace(/[.,;)\]]+$/, '')
      .replace(/\.pdf$/i, '')
      .replace(/v\d+$/i, '');
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
  return { entries: refs, byLabel, byAuthorYear, isEmpty: refs.length === 0 };
}

/**
 * Where the bibliography stops.
 *
 * Modern papers put the references in the middle and an appendix after, so
 * reading to the end of the document swallowed the appendix — and the
 * author-year splitter below then carved that prose into "references" like
 * "Here, AdaRMS denotes…" and offered them as papers to open.
 */
const APPENDIX_RE =
  /^\s*(?:(?:[A-Z]|\d+)[.)]?\s+)?(?:appendix|supplementary|supplemental)\b/i;

/**
 * Does this line *look* like the start of an author-year entry?
 *
 * Two conventions, both common: surname-first ("Vaswani, A., …") and
 * initials-first ("Q. Sun, P. Hong, …").
 *
 * A surname and a comma alone is not enough — prose is full of "However,",
 * "Here,", "FPS,", and worst of all the wrapped continuation "Conference,
 * 2020.", which looks more like an entry than most entries do. What separates
 * them is what follows: an initial, or a given name that ends its token.
 * Prose puts a lowercase word or a number there.
 */
const AUTHOR_YEAR_START_RE =
  /^(?:[A-Z][A-Za-z'’-]+,\s+(?:[A-Z]\.|[A-Z][A-Za-z'’-]*[.,])|[A-Z]\.\s*[A-Z][A-Za-z'’-]+)/;

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

  // Bounded at the appendix, not at the end of the document.
  const rest = lines.slice(headingIdx + 1);
  const appendixAt = rest.findIndex((l) => APPENDIX_RE.test(l));
  const body = appendixAt === -1 ? rest : rest.slice(0, appendixAt);
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

  // Unnumbered author-year. Looking like a start is necessary but not
  // sufficient: an author list wrapped across lines resumes with "D. Damen, J.
  // Engel, …", which is shape-identical to a new entry and split real
  // references into fragments beginning mid-name. What tells them apart is the
  // entry already in hand — a reference ends with its year, so an entry that
  // has not reached one yet is still being read.
  const refs: Reference[] = [];
  let current: string[] = [];
  for (const line of body) {
    const started = current.length > 0;
    const complete = started && YEAR_RE.test(current.join(' '));
    if (AUTHOR_YEAR_START_RE.test(line.trim()) && (!started || complete)) {
      if (started) {
        const ref = makeReference(null, current.join(' '));
        if (ref) refs.push(ref);
      }
      current = [line];
    } else if (started) {
      current.push(line);
    }
  }
  if (current.length) {
    const ref = makeReference(null, current.join(' '));
    if (ref) refs.push(ref);
  }
  return indexReferences(refs);
}

/**
 * How much of an entry the fallback search carries. A mis-split bibliography
 * can leave one "entry" thousands of characters long, and percent-encoding
 * roughly triples it — the CDN in front of Semantic Scholar answers 414 rather
 * than searching, so the fallback that exists to always work stops working.
 * The identifying part of a reference (authors, title) is at the front anyway.
 */
const SEARCH_QUERY_MAX_CHARS = 160;

/**
 * The URL to open for a reference: its own extracted link, or a Semantic
 * Scholar title search over the entry text as a fallback.
 */
export function citationHref(ref: Reference): string {
  if (ref.link) return ref.link;
  // Cut on a word boundary so the query is a phrase rather than a fragment.
  const clipped = ref.text.slice(0, SEARCH_QUERY_MAX_CHARS);
  const query = clipped.length < ref.text.length
    ? clipped.slice(0, clipped.lastIndexOf(' ') + 1 || clipped.length).trim()
    : clipped;
  return `https://www.semanticscholar.org/search?q=${encodeURIComponent(query)}&sort=relevance`;
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

/** Every entry in an index, deduplicated — the reader's "papers this one uses". */
export function allReferences(index: ReferenceIndex): Reference[] {
  return index.entries;
}
