import { GRAPH_QUEUE_MIN_OWNERS, MAX_GRAPH_EXTERNALS } from './constants';
import { paperMatchKey, parsePaperRef } from './papers';
import type { GraphNode, Paper, PaperDraft } from './types';

/**
 * Papers around your library that you do not have: what a tracked paper cites,
 * and what cites it.
 *
 * Stored apart from `graphNodes` on purpose. Its prune is newest-wins over the
 * whole collection, and letting 150 fetched citations evict a year of reading
 * history would be the wrong trade — these are borrowed context, not things the
 * user did. Eviction here drops whole expansions instead, because half a
 * reference list is a lie the UI cannot detect.
 */

export type CitationSourceId = 'local' | 'semantic-scholar' | 'openalex' | 'alphaxiv';

export interface ExternalPaper {
  /** The source's stable id for this paper — also the node id suffix */
  s2Id: string;
  title: string;
  /** Comma-joined, mirroring Paper.authors */
  authors: string;
  venue: string;
  year: number | null;
  citations: number | null;
  /** Best canonical link: arXiv abs, then doi.org, then the source's own page */
  url: string;
  /** paperMatchKey(url) — how a promoted paper is recognised as this node */
  matchKey: string | null;
  /**
   * Subject labels from the source, coarsest first.
   *
   * OpenAlex returns a hierarchy — a specific topic ("generative adversarial
   * networks and image synthesis") inside a subfield ("computer vision and
   * pattern recognition") — so these are parent and child, not two peers.
   * Index 0 is the one worth grouping a reference list under: the specific
   * topic is so narrow that forty references would produce thirty headings.
   */
  topics: string[];
  relation: 'reference' | 'citation';
}

/**
 * A source's subject label, tidied for display and grouping.
 *
 * Deliberately not `normalizeTag`: that caps at five words to stop a model
 * emitting a sentence, which would truncate a real taxonomy label like
 * "Generative Adversarial Networks and Image Synthesis" mid-phrase. These come
 * from a curated vocabulary and are already the right length.
 */
export function topicLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[^a-z0-9]+|[^a-z0-9)]+$/g, '')
    .trim()
    .slice(0, 60);
}

export interface CitationExpansion {
  /** The library Paper.id this hangs off */
  paperId: string;
  fetchedAt: number;
  papers: ExternalPaper[];
  /** One half failed, or a list was cut at its limit */
  partial: boolean;
  /** '' when both halves came back clean; shown under the inspector button */
  note: string;
  /** Which source served each half — provenance, not decoration (see below) */
  sources: { references: CitationSourceId | null; citations: CitationSourceId | null };
}

/** How each source is described to the user. Never the ids. */
export const SOURCE_LABEL: Record<CitationSourceId, string> = {
  local: 'from the paper itself',
  'semantic-scholar': 'from Semantic Scholar',
  openalex: 'from OpenAlex',
  alphaxiv: 'from alphaXiv',
};

/**
 * The reference a citation lookup can actually use, or null.
 *
 * Narrower than `parsePaperRef` on purpose. That returns a `URL:` reference for
 * any http link, which is right for "look up this paper's metadata" and wrong
 * here: OpenAlex and alphaXiv both need an exact identifier, and a bare URL
 * would leave Semantic Scholar — the flakiest tier — as the only source. So a
 * paper with neither an arXiv id nor a DOI is one we cannot expand, and saying
 * so up front beats a button that fails at the network.
 *
 * The cost is real and worth naming: a URL-only document can still have
 * backlinks in the local index, and gating here means we never look. A
 * "Show what this cites" button that can only ever answer "cited by" is the
 * more confusing of the two, so the gate stays.
 */
export function citationRef(paper: Pick<Paper, 'url' | 'pdf'>): string | null {
  for (const url of [paper.url, paper.pdf?.url]) {
    const ref = url ? parsePaperRef(url) : null;
    if (ref && (ref.startsWith('arXiv:') || ref.startsWith('DOI:'))) return ref;
  }
  return null;
}

export function externalNodeId(id: string): string {
  return `ext:${id}`;
}

export function isExternalId(id: string): boolean {
  return id.startsWith('ext:');
}

/**
 * The vertices an expansion implies, deduplicated. A paper reached from two of
 * your papers is one node with two edges, which is exactly how a co-cited work
 * should read.
 */
export function nodesFromExternals(
  expansions: Record<string, CitationExpansion>,
  now: number,
  owned: ReadonlySet<string> = new Set(),
): GraphNode[] {
  const byId = new Map<string, GraphNode>();
  for (const expansion of Object.values(expansions)) {
    for (const paper of expansion.papers) {
      // The user has this work already, so the tracked paper is its node. The
      // citation still draws — `citationEdges` resolves the same match key
      // inward — but no borrowed twin is minted beside the real thing.
      if (paper.matchKey && owned.has(paper.matchKey)) continue;
      const id = externalNodeId(paper.s2Id);
      if (byId.has(id)) continue;
      byId.set(id, {
        id,
        kind: 'external',
        title: paper.title,
        url: paper.url,
        source: [paper.venue, paper.year].filter(Boolean).join(' '),
        tags: [],
        tagSource: 'auto',
        tagInputHash: '',
        completion: 0,
        firstSeenAt: expansion.fetchedAt || now,
        updatedAt: expansion.fetchedAt || now,
      });
    }
  }
  return [...byId.values()];
}

/**
 * Drop what is no longer real: an expansion whose parent paper has been
 * deleted goes with it.
 *
 * It deliberately does *not* drop entries for works the user has since added to
 * their library, though it used to, and that was a real bug — a silent one,
 * because the unit tests for `citationEdges` called it directly and never saw
 * this filter.
 *
 * The reasoning was sound and applied one layer too early. Leaving a borrowed
 * copy beside the tracked paper does put a ghost twin on the map, so it must
 * not become a *node* — but stripping it here removed it from the *edges* too,
 * and an entry resolving to a paper the user owns is precisely the most
 * valuable edge in the system: one thing you have built on another thing you
 * have. Suppression therefore belongs in `nodesFromExternals`, which is where
 * twins actually appear.
 */
export function liveExternals(
  expansions: Record<string, CitationExpansion>,
  papers: readonly Paper[],
): Record<string, CitationExpansion> {
  const paperIds = new Set(papers.map((p) => p.id));
  const out: Record<string, CitationExpansion> = {};
  for (const [id, expansion] of Object.entries(expansions)) {
    if (paperIds.has(expansion.paperId)) out[id] = expansion;
  }
  return out;
}

/** Every match key the library holds — how an owned work is recognised. */
export function ownedMatchKeys(papers: readonly Paper[]): Set<string> {
  return new Set(
    papers.flatMap((p) => {
      const keys = [paperMatchKey(p.url)];
      if (p.pdf) keys.push(paperMatchKey(p.pdf.url));
      return keys.filter((k): k is string => k !== null);
    }),
  );
}

/**
 * One work building on another: A cites B, so A is the newer and B is what it
 * was built on.
 *
 * Deliberately *not* a `GraphEdge`. A similarity edge answers "these two are
 * alike", which is symmetric and true in both directions at once; a citation
 * answers "this one came after that one and used it", which is the opposite —
 * reversing it inverts the claim. Those cannot share a representation, so they
 * do not share a list: `GraphEdge` sorts its endpoints and stacks reasons,
 * which would destroy the direction the moment the two were merged.
 */
export interface CiteEdge {
  /** The citing work — the newer of the pair */
  from: string;
  /** The cited work — what `from` builds on */
  to: string;
  /** Which index asserted it; null when the expansion did not record one */
  source: CitationSourceId | null;
  fetchedAt: number;
}

/**
 * Directed edges from the citation data.
 *
 * `relation` is stored from the parent paper's point of view and is the only
 * thing that knows which way round a pair goes: a `reference` is something the
 * parent cites, a `citation` is something that cites the parent. Reading it
 * here is what lets a lineage be traced rather than merely displayed — it is
 * the difference between "these are related" and "this came from that".
 *
 * The middle case is the payoff: when one paper in your library cites another,
 * that is a real backlink inside your own reading, and it is what a literature
 * review is actually made of.
 *
 * Two externals are never linked to each other. One paper's 150 citations would
 * be an 11,000-edge clique that eats the whole edge budget — and co-citation
 * still emerges for free, because a work cited by two of your papers gets two
 * edges and settles between them.
 */
export function citationEdges(
  expansions: Record<string, CitationExpansion>,
  present: ReadonlySet<string>,
  paperNodeByKey: ReadonlyMap<string, string>,
): CiteEdge[] {
  const out: CiteEdge[] = [];
  // Directional, so a mutual citation between two works survives as two edges
  // rather than being folded into one — which is a real thing that happens
  // between a preprint and its published version.
  const seen = new Set<string>();

  for (const expansion of Object.values(expansions)) {
    const parent = `paper:${expansion.paperId}`;
    if (!present.has(parent)) continue;

    for (const paper of expansion.papers) {
      // Does this resolve to another paper the user already tracks? If so the
      // edge lands on their own node rather than drawing a borrowed duplicate.
      const owned = paper.matchKey ? paperNodeByKey.get(paper.matchKey) : undefined;
      const other = owned && present.has(owned) ? owned : externalNodeId(paper.s2Id);
      if (!present.has(other) || other === parent) continue;

      const reference = paper.relation === 'reference';
      const from = reference ? parent : other;
      const to = reference ? other : parent;
      const key = `${from} ${to}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        from,
        to,
        source: reference ? expansion.sources.references : expansion.sources.citations,
        fetchedAt: expansion.fetchedAt,
      });
    }
  }

  return out;
}

/**
 * Newest-wins over whole expansions. Never a partial list: "40 references" that
 * is silently 12 is worse than not having the paper expanded at all, because
 * nothing on screen says which 28 are missing.
 */
export function pruneExpansions(
  expansions: Record<string, CitationExpansion>,
  cap = MAX_GRAPH_EXTERNALS,
): Record<string, CitationExpansion> {
  const all = Object.values(expansions);
  const total = all.reduce((n, e) => n + e.papers.length, 0);
  if (total <= cap) return expansions;

  const newestFirst = [...all].sort((a, b) => b.fetchedAt - a.fetchedAt);
  const kept: CitationExpansion[] = [];
  let running = 0;
  for (const expansion of newestFirst) {
    if (running + expansion.papers.length > cap) continue;
    kept.push(expansion);
    running += expansion.papers.length;
  }
  return Object.fromEntries(kept.map((e) => [e.paperId, e]));
}

/**
 * Papers you do not have that your own reading keeps pointing at.
 *
 * Co-citation as a recommendation, and the only one here that costs nothing and
 * cannot be wrong: three of your papers independently citing the same work is
 * an argument made by three sets of authors, not a guess made by us. One paper
 * citing something is a reference; three converging on it is a gap in what you
 * have read.
 *
 * Counts distinct citing papers rather than edges, so a single expansion
 * listing a work twice cannot promote it on its own.
 */
export function readingQueue(
  cites: readonly CiteEdge[],
  minOwners = GRAPH_QUEUE_MIN_OWNERS,
): { id: string; owners: number }[] {
  const owners = new Map<string, Set<string>>();
  for (const c of cites) {
    // Only arrows *into* something borrowed, and only from something owned:
    // "what my library builds on that I do not have".
    if (!isExternalId(c.to) || isExternalId(c.from)) continue;
    const set = owners.get(c.to);
    if (set) set.add(c.from);
    else owners.set(c.to, new Set([c.from]));
  }

  return [...owners.entries()]
    .filter(([, set]) => set.size >= minOwners)
    .map(([id, set]) => ({ id, owners: set.size }))
    .sort((a, b) => b.owners - a.owners || (a.id < b.id ? -1 : 1));
}

/**
 * A draft for "Add to my papers". Abstract is left empty on purpose — storing
 * one per external would be about a megabyte for a field only this path needs,
 * so the caller fills it from `fetchPaperMeta` at the moment of adding.
 */
export function paperDraftFromExternal(paper: ExternalPaper, deckId: string): PaperDraft {
  return {
    deckId,
    title: paper.title,
    authors: paper.authors,
    venue: paper.venue,
    year: paper.year,
    citations: paper.citations,
    url: paper.url,
    abstract: '',
    relevance: '',
    status: 'to-read',
    progressPercent: 0,
    leftOff: '',
  };
}

/** Every external in an expansion, split by which direction it came from. */
export function splitByRelation(expansion: CitationExpansion): {
  references: ExternalPaper[];
  citations: ExternalPaper[];
} {
  return {
    references: expansion.papers.filter((p) => p.relation === 'reference'),
    citations: expansion.papers.filter((p) => p.relation === 'citation'),
  };
}
