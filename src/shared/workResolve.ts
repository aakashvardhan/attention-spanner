import {
  ARXIV_DOI_PREFIX,
  FETCH_TIMEOUT_MS,
  OPENALEX_API,
  OPENALEX_TITLE_CANDIDATES,
  OPENALEX_TITLE_MATCH_MIN,
} from './constants';
import { normalizeTitle, parsePaperRef } from './papers';

/**
 * An OpenAlex work, narrowed to the fields anything here reads.
 *
 * Every field is optional because every one of them is genuinely absent
 * somewhere in the corpus — `display_name` is an empty string on records with
 * tens of thousands of citations — so a shape change degrades to a missing
 * value rather than an exception.
 */
export interface OpenAlexWork {
  id?: string;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  cited_by_count?: number | null;
  doi?: string | null;
  referenced_works?: string[];
  authorships?: { author?: { display_name?: string } }[];
  primary_location?: { source?: { display_name?: string } | null } | null;
  /** `pmid` is a full pubmed.ncbi.nlm.nih.gov URL, not a bare id */
  ids?: { doi?: string; pmid?: string };
  primary_topic?: OpenAlexTopic | null;
  topics?: OpenAlexTopic[];
}

export interface OpenAlexTopic {
  display_name?: string;
  subfield?: { display_name?: string } | null;
}

/**
 * One saved thing → zero or one canonical work id.
 *
 * The point of a canonical id is that a citation edge has somewhere to land. A
 * paper reached from a DOI, from an arXiv link, and from a title in a video
 * description has to come out as the same vertex, or the lineage forks into
 * three ghosts of one work.
 *
 * The hard rule here is that **not all resolutions are equal, and the
 * difference must survive**. A DOI hit is the index confirming an identifier
 * the document itself asserted. A title hit is a search engine's opinion, and
 * OpenAlex ranks `title.search` by relevance rather than identity — it returns
 * a plausible neighbour rather than nothing at all. So every resolution carries
 * the method that produced it and a confidence, and callers that mint edges are
 * expected to look at both. A fuzzy match is a candidate, not a fact.
 *
 * Nothing here ever throws for a miss, and a miss is not a failure: an item
 * that resolves to nothing stays in the graph as an untyped node. Dropping it
 * would hide things the user actually saved.
 */

export type ResolveMethod = 'doi' | 'arxiv' | 'pmid' | 'title' | 'none';

/** What a saved page asserts about its own identity, before anything is looked up. */
export interface WorkIdentifiers {
  /** Bare DOI, no `https://doi.org/` prefix and no trailing punctuation */
  doi: string | null;
  /** Bare arXiv id, no `arXiv:` prefix and no version suffix */
  arxiv: string | null;
  /** Bare PubMed id — digits only */
  pmid: string | null;
  /** Best available title; '' when the page had none */
  title: string;
}

export interface WorkResolution {
  /** OpenAlex short id ('W3036167779'); null when nothing resolved */
  canonicalId: string | null;
  /** 1 for an exact identifier; the measured title overlap for a fuzzy hit; 0 for a miss */
  confidence: number;
  method: ResolveMethod;
  /**
   * The provider record that produced this, kept so a resolution can be audited
   * later without a second round trip — and so Phase 2 can read
   * `referenced_works` off it rather than re-fetching the same work.
   *
   * It is the `select`ed projection rather than the unabridged record: a full
   * OpenAlex work carries `abstract_inverted_index`, which is most of its
   * weight and none of its use here. Null on a miss.
   */
  raw: OpenAlexWork | null;
}

/** What `resolveWork` is given: whatever the saved item happens to know about itself. */
export interface WorkInput {
  /** The page's own URL — the highest-precision source of an identifier */
  url?: string;
  title?: string;
  /** Page body, transcript, or description, scanned for identifiers it names */
  text?: string;
}

const MISS: WorkResolution = { canonicalId: null, confidence: 0, method: 'none', raw: null };

/* ---- Extraction ---------------------------------------------------------- */

/**
 * A DOI anywhere in free text.
 *
 * The trailing character class excludes the punctuation that ends a sentence or
 * closes a bracket, because a DOI's own grammar allows almost anything and
 * "…see 10.1038/s41586-020-2012-7." would otherwise capture the full stop and
 * resolve to nothing.
 */
const DOI_IN_TEXT = /\b(10\.\d{4,9}\/[^\s"'<>)\]}]+)/gi;
/** Punctuation that is prose rather than part of the identifier. */
const TRAILING_PUNCT = /[.,;:]+$/;

/**
 * An arXiv id in free text, but only where something says so.
 *
 * Deliberately never a bare `2006.11239`. In a transcript or an article body
 * that pattern is also a date range, a version number, and a price, and Phase 4
 * turns every one of those into a citation edge pointing at a random paper.
 * Requiring the `arXiv:` marker or an arxiv.org URL costs a little recall and
 * buys the precision the whole feature depends on.
 */
const ARXIV_IN_TEXT =
  /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv[:\s]\s*)([a-z-]+(?:\.[a-z]{2})?\/\d{7}|\d{4}\.\d{4,5})(v\d+)?/gi;

/** A PubMed id, likewise only where it is named as one. */
const PMID_IN_TEXT = /(?:pubmed\.ncbi\.nlm\.nih\.gov\/|pmid[:\s]\s*)(\d{1,8})\b/gi;

function firstMatch(text: string, pattern: RegExp): string | null {
  // The patterns are /g, so lastIndex would carry between calls on a shared
  // regex object. Cloning keeps this function safe to call in any order.
  const re = new RegExp(pattern.source, pattern.flags);
  const hit = re.exec(text);
  return hit ? hit[1] : null;
}

/**
 * What a saved page claims to be.
 *
 * The URL is trusted over the body: a page's own address is asserted by
 * whoever published it, while an identifier in the text may belong to something
 * the page merely *discusses* — which is the correct reading for Phase 1 (this
 * item's identity) and the wrong one for Phase 4 (what this item mentions).
 * Those are different questions, so they get different call sites; this one
 * answers the first.
 *
 * Exported on its own because Phase 4 needs exactly this scanner pointed at a
 * transcript instead of a URL.
 */
export function extractIdentifiers(input: WorkInput): WorkIdentifiers {
  let doi: string | null = null;
  let arxiv: string | null = null;
  let pmid: string | null = null;

  // The URL first, through the same parser the paper tracker and the reader
  // already use, so a link recognised there is recognised identically here.
  if (input.url) {
    const ref = parsePaperRef(input.url);
    if (ref?.startsWith('arXiv:')) arxiv = ref.slice('arXiv:'.length);
    else if (ref?.startsWith('DOI:')) doi = ref.slice('DOI:'.length).replace(TRAILING_PUNCT, '');
    const urlPmid = firstMatch(input.url, PMID_IN_TEXT);
    if (urlPmid) pmid = urlPmid;
  }

  if (input.text) {
    if (!doi) {
      const hit = firstMatch(input.text, DOI_IN_TEXT);
      if (hit) doi = hit.replace(TRAILING_PUNCT, '');
    }
    if (!arxiv) arxiv = firstMatch(input.text, ARXIV_IN_TEXT);
    if (!pmid) pmid = firstMatch(input.text, PMID_IN_TEXT);
  }

  return { doi, arxiv, pmid, title: (input.title ?? '').trim() };
}

/**
 * Every identifier named in a body of text, deduplicated and in reading order.
 *
 * The plural counterpart to `extractIdentifiers`, and the one Phase 4 wants: a
 * video description naming six papers is six candidate edges, not one identity.
 * Each hit carries the span that produced it, because an edge the user cannot
 * audit is an edge they cannot trust.
 */
export interface IdentifierMention {
  kind: 'doi' | 'arxiv' | 'pmid';
  value: string;
  /** Character offset of the match in the source text */
  at: number;
  /** The matched substring itself — the seed of the evidence span */
  match: string;
}

export function scanIdentifiers(text: string): IdentifierMention[] {
  const out: IdentifierMention[] = [];
  const seen = new Set<string>();
  const patterns: [IdentifierMention['kind'], RegExp][] = [
    ['doi', DOI_IN_TEXT],
    ['arxiv', ARXIV_IN_TEXT],
    ['pmid', PMID_IN_TEXT],
  ];

  for (const [kind, pattern] of patterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(text)) !== null) {
      const value = kind === 'doi' ? hit[1].replace(TRAILING_PUNCT, '') : hit[1];
      const key = `${kind}:${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, value, at: hit.index, match: hit[0] });
    }
  }

  return out.sort((a, b) => a.at - b.at);
}

/* ---- Title comparison ---------------------------------------------------- */

/**
 * How much two titles agree, 0–1, as a Dice coefficient over their words.
 *
 * Token overlap rather than edit distance because the differences that matter
 * are structural — a trailing " | arXiv", a dropped subtitle, "Is" against
 * "is" — and none of those should cost much, while a genuinely different paper
 * sharing a topic vocabulary should still land far below 1. Reuses
 * `normalizeTitle`, so this agrees by construction with the duplicate detection
 * the paper tracker already does.
 */
export function titleSimilarity(a: string, b: string): number {
  const left = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const right = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/**
 * The best candidate a title search offers, if any of them is good enough.
 *
 * Position in the result list is deliberately ignored beyond tie-breaking:
 * OpenAlex ranks by relevance, and relevance is what returns a paper *about*
 * the query rather than the paper the query names. Only the measured overlap
 * decides.
 */
export function pickTitleMatch(
  title: string,
  candidates: readonly OpenAlexWork[],
  floor = OPENALEX_TITLE_MATCH_MIN,
): { work: OpenAlexWork; score: number } | null {
  let best: { work: OpenAlexWork; score: number } | null = null;
  for (const work of candidates) {
    const other = (work.display_name ?? work.title ?? '').trim();
    if (!other) continue;
    const score = titleSimilarity(title, other);
    if (!best || score > best.score) best = { work, score };
  }
  return best && best.score >= floor ? best : null;
}

/** The bare OpenAlex id out of the URL form the API returns everywhere. */
export function openAlexId(work: OpenAlexWork): string | null {
  if (typeof work.id !== 'string') return null;
  const id = work.id.split('/').pop() ?? '';
  return /^W\d+$/.test(id) ? id : null;
}

/* ---- Resolution ---------------------------------------------------------- */

/**
 * The provider, as a pair of questions rather than a URL.
 *
 * Injected so the decision logic above stays pure and testable without stubbing
 * globals — the same shape `CitationSource` already uses, and the reason the
 * tests for this module need no network.
 */
export interface WorkLookup {
  /** Singleton lookup by an exact key ('doi:10.…', 'pmid:32015507'); null = no such work */
  byId(key: string): Promise<OpenAlexWork | null>;
  /** Relevance-ranked title search; [] when nothing matched */
  byTitle(title: string): Promise<OpenAlexWork[]>;
}

export interface ResolveOptions {
  /**
   * Whether a title search may run when no identifier resolved. On by default,
   * but the one call that costs real budget ($1/1,000 against $0.10/day with no
   * key) and the only one that can be wrong, so bulk callers can turn it off.
   */
  allowTitleSearch?: boolean;
  /** Overrides OPENALEX_TITLE_MATCH_MIN; exposed for tests and tuning */
  titleFloor?: number;
}

/**
 * Resolve one saved item to a canonical work.
 *
 * Exact identifiers first, in descending order of how canonical they are: a
 * published DOI outranks the DataCite DOI arXiv mints for a preprint, which
 * outranks a PubMed id. A miss on one falls through to the next rather than
 * stopping, because index coverage genuinely differs and an arXiv id can
 * resolve where a publisher DOI has not been ingested yet.
 *
 * Every network error is treated as a miss for that identifier alone. A
 * resolver that throws would take the whole graph build down over one flaky
 * lookup, and the honest outcome of "we could not tell" is an untyped node.
 */
export async function resolveWork(
  input: WorkInput,
  lookup: WorkLookup,
  opts: ResolveOptions = {},
): Promise<WorkResolution> {
  const ids = extractIdentifiers(input);

  const exact: [ResolveMethod, string][] = [];
  if (ids.doi) exact.push(['doi', `doi:${ids.doi}`]);
  if (ids.arxiv) exact.push(['arxiv', `doi:${ARXIV_DOI_PREFIX}${ids.arxiv}`]);
  if (ids.pmid) exact.push(['pmid', `pmid:${ids.pmid}`]);

  for (const [method, key] of exact) {
    const work = await lookup.byId(key).catch(() => null);
    if (!work) continue;
    const canonicalId = openAlexId(work);
    if (canonicalId) return { canonicalId, confidence: 1, method, raw: work };
  }

  if (opts.allowTitleSearch !== false && ids.title) {
    const candidates = await lookup.byTitle(ids.title).catch(() => []);
    const hit = pickTitleMatch(ids.title, candidates, opts.titleFloor);
    const canonicalId = hit ? openAlexId(hit.work) : null;
    if (hit && canonicalId) {
      // Never 1, however good the overlap: this is still a search result, and a
      // caller distinguishing asserted from inferred must be able to see that
      // from the number alone as well as from `method`.
      return { canonicalId, confidence: Math.min(hit.score, 0.99), method: 'title', raw: hit.work };
    }
  }

  return MISS;
}

/* ---- The OpenAlex-backed lookup ------------------------------------------ */

/**
 * Fields worth carrying. Everything `parseOpenAlexWork` already reads, plus the
 * two this module needs (`ids` for the PubMed round-trip, `referenced_works` so
 * Phase 2 inherits the reference list from the resolution instead of asking
 * twice) — and deliberately not `abstract_inverted_index`, which is most of a
 * work's bytes and none of its use here.
 */
const SELECT = [
  'id',
  'doi',
  'ids',
  'display_name',
  'title',
  'publication_year',
  'cited_by_count',
  'referenced_works',
  'primary_topic',
  'topics',
  'authorships',
  'primary_location',
].join(',');

/**
 * A title, reduced to something OpenAlex's filter grammar will accept.
 *
 * Verified the hard way: `filter=title.search:` treats a comma as a filter
 * separator and rejects the request with a 400 — and percent-encoding it does
 * *not* help, despite the API's own error text advising exactly that, because
 * the edge proxy decodes before it splits. "Attention, Learn to Solve Routing
 * Problems!" fails as `%2C` and succeeds with the punctuation gone.
 *
 * Stripping costs nothing: `title.search` is tokenized full-text matching, so
 * punctuation was never contributing to the match. Reuses `normalizeTitle` so
 * the query and the scoring agree on what a word is.
 */
export function openAlexTitleQuery(title: string): string {
  return normalizeTitle(title).slice(0, 300).trim();
}

/**
 * A 404 is a clean miss and returns null; anything else throws.
 *
 * The distinction is load-bearing. OpenAlex answers an unknown identifier with
 * a 404 whose body is HTML, so parsing before checking status would throw on
 * the one outcome that is not an error — and treating a 500 or a timeout as
 * "no such paper" would quietly write a permanent miss for a transient blip.
 */
async function getWork(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`openalex ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The live provider.
 *
 * `apiKey` is passed in by the caller from the user's own settings and is empty
 * by default — nothing is ever baked into the bundle. Keyless still works:
 * singleton lookups are free and unlimited on every tier, so identifier
 * resolution is unaffected, and only title search draws on the $0.10/day
 * no-key budget. The key is a query parameter rather than a header, which is
 * what OpenAlex documents (`?api_key=…`) and is why it is appended here rather
 * than set on the request.
 */
export function openAlexLookup(apiKey = ''): WorkLookup {
  const auth = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : '';

  return {
    async byId(key) {
      const work = await getWork(`${OPENALEX_API}/works/${key}?select=${SELECT}${auth}`);
      return (work as OpenAlexWork | null) ?? null;
    },

    async byTitle(title) {
      // `title.search` rather than the bare `search` param: the latter also
      // matches the abstract, which is how a query returns papers that merely
      // discuss the work being looked for.
      const query = encodeURIComponent(openAlexTitleQuery(title));
      if (!query) return [];
      const page = (await getWork(
        `${OPENALEX_API}/works?filter=title.search:${query}` +
          `&per-page=${OPENALEX_TITLE_CANDIDATES}&select=${SELECT}${auth}`,
      )) as { results?: OpenAlexWork[] } | null;
      return page?.results ?? [];
    },
  };
}
