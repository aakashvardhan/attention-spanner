import { allReferences, parseBibliography } from './bibliography';
import { topicLabel, type CitationSourceId, type ExternalPaper } from './citations';
import {
  ARXIV_DOI_PREFIX,
  FETCH_TIMEOUT_MS,
  OPENALEX_API,
  OPENALEX_HYDRATE_MAX,
  SEMANTIC_SCHOLAR_CITES_LIMIT,
  SEMANTIC_SCHOLAR_PAPER_API,
  SEMANTIC_SCHOLAR_REFS_LIMIT,
} from './constants';
import { backlinksFor, type DocCitations } from './docCitations';
import { parsePaperRef } from './papers';
import { openAlexLookup, resolveWork, type OpenAlexWork } from './workResolve';

/**
 * Where citation data comes from, in order of what it costs the user.
 *
 * Semantic Scholar's anonymous pool is about one request per second shared
 * across every client on the internet, so 429s are routine rather than
 * exceptional — a feature whose central action is "expand this paper" cannot
 * have a single point of failure that flaky. Hence a chain, in the same shape
 * as the model routing in ai/routing.ts.
 *
 * Cheapest first is a deliberate inversion of "richest first": a paper's own
 * bibliography is the most authoritative outbound list that exists, and the
 * remote indexes are *reconstructing* what the document already states. When we
 * have the document, asking the internet is both slower and worse.
 */

export interface CitationEnv {
  semanticScholarKey: string;
  /**
   * The paper's title, so a lookup can fall back to searching for it when the
   * identifier is not in the index. Optional: a source that has no title simply
   * cannot use that fallback.
   */
  title?: string;
  /** The reverse index built by the reader (Phase 4b) */
  docCitations: Record<string, DocCitations>;
}

export interface CitationSource {
  id: CitationSourceId;
  /** Some sources serve one direction only — say so rather than returning [] */
  supports: { references: boolean; citations: boolean };
  available(ref: string, env: CitationEnv): boolean;
  fetchReferences(ref: string, env: CitationEnv): Promise<ExternalPaper[]>;
  fetchCitations(ref: string, env: CitationEnv): Promise<ExternalPaper[]>;
}

/** Raised when a source cannot answer; the chain moves on rather than failing. */
export class SourceUnavailable extends Error {}

function timeoutSignal(): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function getJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const { signal, done } = timeoutSignal();
  try {
    const res = await fetch(url, { signal, headers });
    if (!res.ok) throw new SourceUnavailable(`${res.status}`);
    return await res.json();
  } catch (error) {
    throw error instanceof SourceUnavailable ? error : new SourceUnavailable('network');
  } finally {
    done();
  }
}

/** The canonical link for a paper, preferring what a reader can actually open. */
function linkFor(arxiv: string | null, doi: string | null, fallback: string): string {
  if (arxiv) return `https://arxiv.org/abs/${arxiv}`;
  if (doi) return `https://doi.org/${doi}`;
  return fallback;
}

function external(
  id: string,
  title: string,
  authors: string,
  venue: string,
  year: number | null,
  citations: number | null,
  url: string,
  relation: ExternalPaper['relation'],
  topics: string[] = [],
): ExternalPaper {
  return {
    s2Id: id,
    title,
    authors,
    venue,
    year,
    citations,
    url,
    // The same helper the reader and the paper tracker use, so a promoted
    // external is recognised as the paper it became.
    matchKey: parsePaperRef(url)?.toLowerCase() ?? null,
    topics,
    relation,
  };
}

/* ---- Semantic Scholar ---------------------------------------------------- */

interface S2Row {
  paperId?: string | null;
  title?: string | null;
  venue?: string | null;
  year?: number | null;
  citationCount?: number | null;
  authors?: { name?: string }[] | null;
  externalIds?: { ArXiv?: string; DOI?: string } | null;
  fieldsOfStudy?: string[] | null;
}

const S2_FIELDS =
  'paperId,title,year,venue,citationCount,authors.name,externalIds,fieldsOfStudy';

/**
 * Rows out of an S2 references/citations payload. Entries with no id or no
 * title are skipped: the API returns null-filled placeholders for records it
 * holds but will not disclose, and a nameless node is worse than a missing one.
 */
export function parseS2Rows(
  payload: unknown,
  relation: ExternalPaper['relation'],
): ExternalPaper[] {
  const data = payload as { data?: unknown } | null;
  const rows = Array.isArray(data?.data) ? data.data : [];
  const out: ExternalPaper[] = [];

  for (const entry of rows) {
    const wrapper = entry as Record<string, unknown>;
    // References nest under `citedPaper`, citations under `citingPaper`.
    const raw = (wrapper.citedPaper ?? wrapper.citingPaper ?? wrapper) as S2Row;
    if (!raw || typeof raw.paperId !== 'string' || typeof raw.title !== 'string') continue;
    if (!raw.paperId || !raw.title.trim()) continue;

    const arxiv = raw.externalIds?.ArXiv ?? null;
    const doi = raw.externalIds?.DOI ?? null;
    out.push(
      external(
        raw.paperId,
        raw.title.trim(),
        (raw.authors ?? []).map((a) => a?.name).filter(Boolean).join(', '),
        raw.venue ?? '',
        raw.year ?? null,
        raw.citationCount ?? null,
        linkFor(arxiv, doi, `https://www.semanticscholar.org/paper/${raw.paperId}`),
        relation,
        // "Computer Science" — a shelf, not a subject, but better than nothing
        // when this is the only source that answered.
        (raw.fieldsOfStudy ?? []).map(topicLabel).filter(Boolean).slice(0, 1),
      ),
    );
  }
  return out;
}

async function s2(
  ref: string,
  kind: 'references' | 'citations',
  limit: number,
  env: CitationEnv,
): Promise<ExternalPaper[]> {
  const url = `${SEMANTIC_SCHOLAR_PAPER_API}${ref}/${kind}?fields=${S2_FIELDS}&limit=${limit}`;
  const payload = await getJson(url, env.semanticScholarKey ? { 'x-api-key': env.semanticScholarKey } : undefined);
  return parseS2Rows(payload, kind === 'references' ? 'reference' : 'citation');
}

export const semanticScholarSource: CitationSource = {
  id: 'semantic-scholar',
  supports: { references: true, citations: true },
  available: (ref) => ref !== '',
  fetchReferences: (ref, env) => s2(ref, 'references', SEMANTIC_SCHOLAR_REFS_LIMIT, env),
  fetchCitations: (ref, env) => s2(ref, 'citations', SEMANTIC_SCHOLAR_CITES_LIMIT, env),
};

/* ---- OpenAlex ------------------------------------------------------------ */

/**
 * The OpenAlex lookup for a paper reference, or null when there is none.
 *
 * Only exact identifiers: a DOI directly, and an arXiv id through the DataCite
 * DOI arXiv now mints for every paper. Deliberately no title search — a fuzzy
 * fallback that quietly returns a *different* paper's references is worse than
 * no fallback at all, because nothing downstream could detect it.
 */
export function openAlexKey(ref: string): string | null {
  if (ref.startsWith('DOI:')) return `doi:${ref.slice(4)}`;
  if (ref.startsWith('arXiv:')) return `doi:${ARXIV_DOI_PREFIX}${ref.slice(6)}`;
  return null;
}

/* The work record itself lives in workResolve.ts, which owns the OpenAlex
   adapter — so the dependency runs one way, this file to that one. */

/**
 * A work's subject, coarsest first.
 *
 * The subfield leads because it is the level a reference list groups usefully
 * at: forty references carry perhaps six subfields but thirty specific topics,
 * and thirty headings is not a categorisation. Verified against the live API —
 * every field here is optional, so a shape change degrades to no topic rather
 * than an exception.
 */
export function openAlexTopics(work: OpenAlexWork): string[] {
  const primary = work.primary_topic ?? work.topics?.[0] ?? null;
  if (!primary) return [];
  return [primary.subfield?.display_name, primary.display_name]
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    .map(topicLabel)
    .filter((t, i, all) => t !== '' && all.indexOf(t) === i);
}

export function parseOpenAlexWork(
  work: OpenAlexWork,
  relation: ExternalPaper['relation'],
): ExternalPaper | null {
  const id = typeof work.id === 'string' ? work.id.split('/').pop() ?? '' : '';
  const title = (work.display_name ?? work.title ?? '').trim();
  if (!id || !title) return null;

  const doi = (work.doi ?? work.ids?.doi ?? '').replace(/^https?:\/\/doi\.org\//i, '') || null;
  // arXiv papers carry the DataCite DOI; recover the bare id so the link is the
  // abstract page a reader wants rather than a DOI redirect.
  const arxiv = doi?.toLowerCase().startsWith(ARXIV_DOI_PREFIX.toLowerCase())
    ? doi.slice(ARXIV_DOI_PREFIX.length)
    : null;

  return external(
    id,
    title,
    (work.authorships ?? []).map((a) => a?.author?.display_name).filter(Boolean).join(', '),
    work.primary_location?.source?.display_name ?? '',
    work.publication_year ?? null,
    work.cited_by_count ?? null,
    linkFor(arxiv, doi, `https://openalex.org/${id}`),
    relation,
    openAlexTopics(work),
  );
}

/** The canonical link for a reference, so `resolveWork` can parse it back out. */
export function refToUrl(ref: string): string {
  if (ref.startsWith('arXiv:')) return `https://arxiv.org/abs/${ref.slice('arXiv:'.length)}`;
  if (ref.startsWith('DOI:')) return `https://doi.org/${ref.slice('DOI:'.length)}`;
  return '';
}

/**
 * The OpenAlex work behind a reference, with a title search behind the
 * identifier.
 *
 * The identifier alone is not enough, and this was measured rather than
 * guessed: of twelve well-known arXiv papers, three have no record under the
 * DataCite DOI arXiv mints — Transformer, BERT and RoBERTa all 404, because
 * OpenAlex indexed the version published at a venue and never linked the
 * preprint. The DOIs themselves are fine; doi.org and DataCite both serve them.
 *
 * So a miss falls through to the paper's title, which recovers roughly a third
 * of them. It is not a cure: BERT's record exists with 32,938 citations and an
 * empty title string, so nothing can find it by name either. Those stay
 * unresolved and their nodes stay untyped, which is the honest outcome.
 */
async function openAlexWorkFor(ref: string, env: CitationEnv): Promise<OpenAlexWork> {
  // No API key: singleton lookups are free and unlimited on every tier, and the
  // keyless title-search budget is ~100 a day — comfortably more than expanding
  // a personal library costs. A key becomes worth threading through if that
  // ever stops being true.
  const resolved = await resolveWork({ url: refToUrl(ref), title: env.title ?? '' }, openAlexLookup());
  if (!resolved.raw) throw new SourceUnavailable('not in the index');
  return resolved.raw;
}

export const openAlexSource: CitationSource = {
  id: 'openalex',
  supports: { references: true, citations: true },
  // A title alone is enough to try: the identifier is preferred, not required.
  available: (ref, env) => openAlexKey(ref) !== null || Boolean(env.title?.trim()),

  async fetchReferences(ref, env) {
    const work = await openAlexWorkFor(ref, env);

    // `referenced_works` is a list of ids only, so one batched hydration. Cap it
    // at a single request: a fallback needing two round-trips is not a fallback.
    const ids = (work.referenced_works ?? []).slice(0, OPENALEX_HYDRATE_MAX);
    if (!ids.length) return [];
    const filter = ids.map((u) => u.split('/').pop()).filter(Boolean).join('|');
    const page = (await getJson(
      `${OPENALEX_API}/works?filter=openalex:${filter}&per-page=${OPENALEX_HYDRATE_MAX}`,
    )) as { results?: OpenAlexWork[] };
    return (page.results ?? [])
      .map((w) => parseOpenAlexWork(w, 'reference'))
      .filter((p): p is ExternalPaper => p !== null);
  },

  async fetchCitations(ref, env) {
    const work = await openAlexWorkFor(ref, env);
    const id = typeof work.id === 'string' ? work.id.split('/').pop() : null;
    if (!id) throw new SourceUnavailable('no identifier');

    const page = (await getJson(
      `${OPENALEX_API}/works?filter=cites:${id}&per-page=${SEMANTIC_SCHOLAR_CITES_LIMIT}&sort=cited_by_count:desc`,
    )) as { results?: OpenAlexWork[] };
    return (page.results ?? [])
      .map((w) => parseOpenAlexWork(w, 'citation'))
      .filter((p): p is ExternalPaper => p !== null);
  },
};

/** Bibliography entries as externals. */
export function referencesFromText(text: string, cap: number): ExternalPaper[] {
  const index = parseBibliography(text);
  const out: ExternalPaper[] = [];
  const seen = new Set<string>();

  for (const entry of allReferences(index)) {
    if (!entry.link) continue;
    const key = parsePaperRef(entry.link)?.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // The bibliography holds a citation string, not structured metadata — the
    // entry text is the honest title here, trimmed to something readable.
    out.push(
      external(key, entry.text.slice(0, 180), '', '', entry.year, null, entry.link, 'reference'),
    );
    if (out.length === cap) break;
  }
  return out;
}

/**
 * The tier that needs no network and cannot rate-limit. Outbound comes from the
 * document's own reference list; inbound from which of the user's own documents
 * cite it — narrower than a global index, and for tracking a personal corpus
 * frequently the more useful answer.
 */
export const localSource: CitationSource = {
  id: 'local',
  supports: { references: false, citations: true },
  available: (ref, env) => backlinksFor(ref.toLowerCase(), env.docCitations).length > 0,

  async fetchReferences() {
    throw new SourceUnavailable('no local copy');
  },

  async fetchCitations(ref, env) {
    return backlinksFor(ref.toLowerCase(), env.docCitations).map((doc) =>
      external(doc.docKey, doc.title, '', '', null, null, doc.docUrl, 'citation'),
    );
  },
};

/**
 * Ordered by cost to the user, cheapest first — not by richness.
 *
 * Semantic Scholar used to sit second on the theory that its anonymous pool was
 * about one request per second. Measured against the live API it is nearer
 * zero: a single unauthenticated request, first of the session, returns 429.
 * Every expansion was therefore spending a guaranteed failure and a timeout
 * before reaching a source that works, so it now sits behind OpenAlex — whose
 * singleton lookups are free and unlimited on every tier. It stays in the chain
 * because a user with an API key gets a good source back, and because it
 * answers for identifiers OpenAlex has not ingested.
 */
export const CITATION_SOURCES: readonly CitationSource[] = [
  localSource,
  openAlexSource,
  semanticScholarSource,
];

/**
 * Walk the chain for one direction. Skips a source that does not serve it at
 * all, advances past a failure — including a 404, because coverage differs
 * between indexes and a miss is worth a retry elsewhere — and stops at the
 * first source that returns rows.
 */
export async function collect(
  direction: 'references' | 'citations',
  ref: string,
  env: CitationEnv,
  sources: readonly CitationSource[] = CITATION_SOURCES,
  gate: (id: CitationSourceId) => Promise<void> = async () => {},
): Promise<{ papers: ExternalPaper[]; source: CitationSourceId | null }> {
  for (const source of sources) {
    if (!source.supports[direction]) continue;
    if (!source.available(ref, env)) continue;
    try {
      await gate(source.id);
      const papers =
        direction === 'references'
          ? await source.fetchReferences(ref, env)
          : await source.fetchCitations(ref, env);
      if (papers.length) return { papers, source: source.id };
    } catch {
      // Try the next one. Reporting which index refused is noise: what the user
      // needs is what they got and where it came from.
    }
  }
  return { papers: [], source: null };
}
