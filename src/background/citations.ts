import { resolvePaperDeckId } from '../shared/ai/connectors/base';
import {
  citationRef,
  paperDraftFromExternal,
  pruneExpansions,
  type CitationExpansion,
  type CitationSourceId,
  type ExternalPaper,
} from '../shared/citations';
import { collect, type CitationEnv } from '../shared/citationSources';
import {
  CITATION_EXPANSION_TTL_MS,
  OPENALEX_MIN_INTERVAL_MS,
  SEMANTIC_SCHOLAR_MIN_INTERVAL_MS,
} from '../shared/constants';
import { fetchPaperMeta } from '../shared/papers';
import { addPaper } from './papers';
import { getLocal, getSettings, setLocal } from '../shared/storage';

/**
 * Expanding a paper's citations. The rules live in shared/citationSources.ts;
 * this is the chrome-touching layer — storage, tokens, and the rate gate.
 *
 * It runs in the service worker rather than the page because it writes a
 * collection (the same rule every paper write follows), and because the
 * assistant's tool has to reach it too.
 */

const MIN_INTERVAL: Partial<Record<CitationSourceId, number>> = {
  'semantic-scholar': SEMANTIC_SCHOLAR_MIN_INTERVAL_MS,
  openalex: OPENALEX_MIN_INTERVAL_MS,
};

/**
 * One promise chain per host, so concurrent expansions cannot burst. The user
 * expands one paper at a time, which makes the serialization invisible — and
 * hammering a ~1 rps shared pool is how you earn a 429 storm rather than data.
 */
const lastCallAt = new Map<CitationSourceId, number>();
let queue: Promise<void> = Promise.resolve();

function gate(id: CitationSourceId): Promise<void> {
  const wait = MIN_INTERVAL[id];
  if (!wait) return Promise.resolve();
  queue = queue.then(async () => {
    const since = Date.now() - (lastCallAt.get(id) ?? 0);
    if (since < wait) await new Promise((r) => setTimeout(r, wait - since));
    lastCallAt.set(id, Date.now());
  });
  return queue;
}

/** What the user is told when a half came back empty. Outcome, never plumbing. */
function noteFor(references: ExternalPaper[], citations: ExternalPaper[]): string {
  if (!references.length && !citations.length) {
    return "Couldn't find this paper's citations anywhere. Open the PDF and its own reference list will work offline.";
  }
  if (!references.length) return 'Found what cites this, but not its own reference list.';
  if (!citations.length) return 'Found its reference list, but nothing that cites it yet.';
  return '';
}

export async function expandCitations(
  paperId: string,
  force = false,
): Promise<{ ok: boolean; added?: number; note?: string; error?: string }> {
  const { papers, graphCitations, docCitations } = await getLocal(
    'papers',
    'graphCitations',
    'docCitations',
  );

  const paper = papers.find((p) => p.id === paperId);
  if (!paper) return { ok: false, error: 'That paper is no longer in your library.' };

  const ref = citationRef(paper);
  if (!ref) {
    return { ok: false, error: 'No arXiv id or DOI on this paper, so there is nothing to look up.' };
  }

  // A reference list never changes and a citation list changes slowly, so
  // re-expanding inside the window is a free no-op — which is what makes the
  // button safe to press twice.
  const existing = graphCitations[paperId];
  if (existing && !force && Date.now() - existing.fetchedAt < CITATION_EXPANSION_TTL_MS) {
    return { ok: true, added: existing.papers.length, note: existing.note };
  }

  const settings = await getSettings();
  const env: CitationEnv = {
    semanticScholarKey: settings.semanticScholarApiKey.trim(),
    // Lets OpenAlex fall back to a title search when the identifier is not in
    // the index — which is how a paper like the Transformer, whose arXiv DOI
    // OpenAlex never linked, gets expanded at all.
    title: paper.title,
    docCitations,
  };

  // The two directions are independent: one source may serve the references
  // while another serves the citations, and that is a normal result rather
  // than a degraded one.
  const [refs, cites] = await Promise.all([
    collect('references', ref, env, undefined, gate),
    collect('citations', ref, env, undefined, gate),
  ]);

  const found = [...refs.papers, ...cites.papers];
  if (!found.length) return { ok: false, error: noteFor([], []) };

  const expansion: CitationExpansion = {
    paperId,
    fetchedAt: Date.now(),
    papers: found,
    // Partial success is success: never discard a half that already cost a
    // second of a shared rate limit because the other half failed.
    partial: !refs.papers.length || !cites.papers.length,
    note: noteFor(refs.papers, cites.papers),
    sources: { references: refs.source, citations: cites.source },
  };

  await setLocal({
    graphCitations: pruneExpansions({ ...graphCitations, [paperId]: expansion }),
  });
  return { ok: true, added: found.length, note: expansion.note };
}

/**
 * Promote a borrowed paper into the library.
 *
 * The abstract is fetched here rather than stored on every external — it is the
 * one field this path needs and six hundred of them would be about a megabyte
 * of storage for nothing. A lookup failure is not fatal: the paper is worth
 * saving with the metadata the citation already carried.
 *
 * Nothing else has to change afterwards. `liveExternals` drops the borrowed
 * node on the match key, and `citationEdges` re-derives the same edge onto the
 * new paper node from the same unchanged expansion — the link re-points itself.
 */
export async function addExternalPaper(
  nodeId: string,
): Promise<{ ok: boolean; paperId?: string; error?: string }> {
  const { graphCitations } = await getLocal('graphCitations');
  const wanted = nodeId.startsWith('ext:') ? nodeId.slice('ext:'.length) : nodeId;

  const found = Object.values(graphCitations)
    .flatMap((e) => e.papers)
    .find((p) => p.s2Id === wanted);
  if (!found) return { ok: false, error: 'That paper is no longer in the graph.' };

  const deckId = await resolvePaperDeckId();
  const draft = paperDraftFromExternal(found, deckId);

  const meta = await fetchPaperMeta(found.url);
  if (meta.ok) {
    draft.abstract = meta.meta.abstract;
    draft.venue = draft.venue || meta.meta.venue;
    draft.year = draft.year ?? meta.meta.year;
    draft.citations = draft.citations ?? meta.meta.citations;
  }

  const res = await addPaper(draft);
  if (!res.ok) return { ok: false, error: res.error };

  // Mint the node now rather than waiting for the next graph open. Without
  // this the borrowed node vanishes (it is owned already) while its replacement
  // does not exist yet, so the paper the user just saved disappears from the
  // map entirely — the opposite of what pressing Add should do.
  return { ok: true, paperId: res.paper.id };
}

/**
 * Label cited papers the sources had no subject for.
 *
 * Keyed by the source's own id rather than a node id, because a cited paper may
 * have no library entry at all — it is stored inside its expansion.
 * An assignment for a paper that has since been evicted is dropped rather than
 * resurrecting it, the same rule `applyTags` follows for nodes.
 */
export async function applyCitedTags(
  assignments: { id: string; tags: string[] }[],
): Promise<{ ok: boolean; updated: number }> {
  const { graphCitations } = await getLocal('graphCitations');
  const byId = new Map(assignments.map((a) => [a.id, a.tags]));
  let updated = 0;

  const next: Record<string, CitationExpansion> = {};
  for (const [key, expansion] of Object.entries(graphCitations)) {
    next[key] = {
      ...expansion,
      papers: expansion.papers.map((paper) => {
        const tags = byId.get(paper.s2Id);
        // Never overwrite a real subject from the source with a guessed one.
        if (!tags || paper.topics.length > 0) return paper;
        updated += 1;
        return { ...paper, topics: tags };
      }),
    };
  }

  if (updated > 0) await setLocal({ graphCitations: next });
  return { ok: true, updated };
}
