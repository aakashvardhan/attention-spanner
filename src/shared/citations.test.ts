import { describe, expect, it } from 'vitest';
import {
  citationEdges,
  citationRef,
  externalNodeId,
  liveExternals,
  nodesFromExternals,
  ownedMatchKeys,
  pruneExpansions,
  readingQueue,
  type CitationExpansion,
  type ExternalPaper,
} from './citations';
import { paperMatchKey } from './papers';
import type { Paper } from './types';

const NOW = 1_700_000_000_000;

function ext(over: Partial<ExternalPaper> = {}): ExternalPaper {
  const url = over.url ?? 'https://arxiv.org/abs/1706.03762';
  return {
    s2Id: 's2-1',
    title: 'Attention Is All You Need',
    authors: 'Vaswani et al.',
    venue: 'NeurIPS',
    year: 2017,
    citations: 100,
    url,
    matchKey: paperMatchKey(url),
    topics: [],
    relation: 'reference',
    ...over,
  };
}

function expansion(over: Partial<CitationExpansion> = {}): CitationExpansion {
  return {
    paperId: 'p1',
    fetchedAt: NOW,
    papers: [ext()],
    partial: false,
    note: '',
    sources: { references: 'semantic-scholar', citations: null },
    ...over,
  };
}

function paper(over: Partial<Paper> = {}): Paper {
  return {
    id: 'p1',
    deckId: 'd1',
    title: 'My paper',
    authors: '',
    venue: '',
    year: null,
    citations: null,
    url: 'https://arxiv.org/abs/2006.11239',
    abstract: '',
    relevance: '',
    status: 'reading',
    progressPercent: 0,
    leftOff: '',
    addedAt: NOW,
    updatedAt: NOW,
    lastReadAt: null,
    ...over,
  };
}

/** Directed edges, reduced to from/to so the assertions read as arrows. */
function edgesFrom(
  expansions: Record<string, CitationExpansion>,
  present: string[],
  keys: Map<string, string> = new Map(),
) {
  return citationEdges(expansions, new Set(present), keys).map(({ from, to }) => ({ from, to }));
}

describe('citationRef', () => {
  it('takes an arXiv id or a DOI', () => {
    expect(citationRef({ url: 'https://arxiv.org/abs/1706.03762' })).toBe('arXiv:1706.03762');
    expect(citationRef({ url: 'https://doi.org/10.1145/3292500.3330701' })).toBe(
      'DOI:10.1145/3292500.3330701',
    );
  });

  // The bug this fixes, caught by driving the real UI: parsePaperRef returns a
  // `URL:` reference for *any* http link, so the inspector's "Show what this
  // cites" button never disabled — it stayed live on papers no source could
  // resolve, and failed at the network instead of saying so up front.
  it('refuses a plain URL with no identifier in it', () => {
    expect(citationRef({ url: 'https://example.test/some/chapter' })).toBe(null);
  });

  it('falls back to the attached PDF when the main link has nothing', () => {
    const withPdf = {
      url: 'https://example.test/landing-page',
      pdf: { url: 'https://arxiv.org/pdf/2006.11239v3.pdf', page: 1, pageCount: 10, offset: 0 },
    };

    expect(citationRef(withPdf)).toBe('arXiv:2006.11239');
  });

  it('refuses a paper with no links at all', () => {
    expect(citationRef({ url: '' })).toBe(null);
  });
});

describe('externalNodeId', () => {
  // Node ids share one namespace. A collision would silently merge a borrowed
  // paper with something the user actually has.
  it('cannot collide with any other kind of node id', () => {
    const id = externalNodeId('abc');

    expect(id).toBe('ext:abc');
    for (const prefix of ['paper:', 'bm:', 'yt:', 'recording:']) {
      expect(id.startsWith(prefix)).toBe(false);
    }
  });
});

describe('nodesFromExternals', () => {
  it('makes one node per paper however many expansions reached it', () => {
    const shared = ext({ s2Id: 'shared' });
    const nodes = nodesFromExternals(
      {
        p1: expansion({ paperId: 'p1', papers: [shared] }),
        p2: expansion({ paperId: 'p2', papers: [shared] }),
      },
      NOW,
    );

    expect(nodes).toHaveLength(1);
  });

  it('marks them as borrowed and unread', () => {
    const [node] = nodesFromExternals({ p1: expansion() }, NOW);

    expect(node.kind).toBe('external');
    expect(node.completion).toBe(0);
    expect(node.tags).toEqual([]);
  });
});

describe('liveExternals', () => {
  it('drops a whole expansion once its paper is deleted', () => {
    const live = liveExternals({ p1: expansion({ paperId: 'p1' }) }, []);

    expect(Object.keys(live)).toEqual([]);
  });

  /**
   * It used to strip these, and that quietly destroyed the best edge in the
   * system: one paper you own citing another paper you own. The entry has to
   * survive here so `citationEdges` can resolve it inward — suppressing the
   * duplicate is `nodesFromExternals`' job, tested below.
   */
  it('keeps an entry for a paper the user owns, so the citation can still land', () => {
    const added = paper({ id: 'p2', url: 'https://arxiv.org/abs/1706.03762' });
    const live = liveExternals({ p1: expansion() }, [paper(), added]);

    expect(live.p1.papers).toHaveLength(1);
  });
});

describe('nodesFromExternals — ghost twins', () => {
  // Otherwise "Add to my papers" leaves a borrowed copy sitting beside the real
  // paper: the same work drawn twice, with no way to tell which is which.
  it('mints no node for a work the user already has', () => {
    const owned = ownedMatchKeys([paper({ id: 'p2', url: 'https://arxiv.org/abs/1706.03762' })]);

    expect(nodesFromExternals({ p1: expansion() }, NOW, owned)).toEqual([]);
  });

  it('recognises the owned paper through a different link to the same work', () => {
    const owned = ownedMatchKeys([paper({ id: 'p2', url: 'https://arxiv.org/pdf/1706.03762v5' })]);

    expect(nodesFromExternals({ p1: expansion() }, NOW, owned)).toEqual([]);
  });

  it('still mints a node for a work the user does not have', () => {
    expect(nodesFromExternals({ p1: expansion() }, NOW, new Set())).toHaveLength(1);
  });
});

describe('citationEdges', () => {
  it('points from the paper to what it references', () => {
    const edges = edgesFrom({ p1: expansion() }, ['paper:p1', 'ext:s2-1']);

    expect(edges).toEqual([{ from: 'paper:p1', to: 'ext:s2-1' }]);
  });

  /**
   * The other half of the same field, and the reason direction has to be read
   * rather than assumed: a `citation` is something that cites the parent, so
   * the arrow runs *into* the parent. Getting this backwards would draw the
   * newer work as an ancestor of the older one.
   */
  it('points from the citing work into the paper for a citation', () => {
    const edges = edgesFrom(
      { p1: expansion({ papers: [ext({ relation: 'citation' })] }) },
      ['paper:p1', 'ext:s2-1'],
    );

    expect(edges).toEqual([{ from: 'ext:s2-1', to: 'paper:p1' }]);
  });

  // The payoff: a real backlink inside the user's own reading list, which is
  // what a literature review is actually made of.
  it('links two papers in the library when one cites the other', () => {
    const keys = new Map([['arxiv:1706.03762', 'paper:p2']]);
    const edges = edgesFrom({ p1: expansion() }, ['paper:p1', 'paper:p2'], keys);

    expect(edges).toEqual([{ from: 'paper:p1', to: 'paper:p2' }]);
  });

  it('prefers the tracked paper over drawing a borrowed duplicate', () => {
    const keys = new Map([['arxiv:1706.03762', 'paper:p2']]);
    const edges = edgesFrom({ p1: expansion() }, ['paper:p1', 'paper:p2', 'ext:s2-1'], keys);

    expect(edges.map((e) => e.to)).toEqual(['paper:p2']);
  });

  // A preprint and its published version routinely cite each other. Folding
  // that into one edge would lose a real fact about the pair.
  it('keeps both arrows when two works cite each other', () => {
    const keys = new Map([['arxiv:1706.03762', 'paper:p2']]);
    const edges = edgesFrom(
      { p1: expansion({ papers: [ext(), ext({ relation: 'citation' })] }) },
      ['paper:p1', 'paper:p2'],
      keys,
    );

    expect(edges).toEqual([
      { from: 'paper:p1', to: 'paper:p2' },
      { from: 'paper:p2', to: 'paper:p1' },
    ]);
  });

  // One paper's 150 citations would be an 11,000-edge clique that eats the
  // entire edge budget. Co-citation still emerges: a work cited by two of your
  // papers gets two edges and settles between them.
  it('never links two borrowed papers to each other', () => {
    const edges = edgesFrom(
      { p1: expansion({ papers: [ext({ s2Id: 'a' }), ext({ s2Id: 'b' })] }) },
      ['paper:p1', 'ext:a', 'ext:b'],
    );

    expect(edges.some((e) => e.from.startsWith('ext:') && e.to.startsWith('ext:'))).toBe(false);
  });

  // Promotion has to be free. Nothing migrates: the same stored expansion is
  // re-derived and the edge simply lands on the new paper node instead.
  it('re-points onto the new paper after a borrowed one is added, with no stored change', () => {
    const stored = { p1: expansion() };

    const before = edgesFrom(stored, ['paper:p1', 'ext:s2-1']);
    const after = edgesFrom(
      stored,
      ['paper:p1', 'paper:new'],
      new Map([['arxiv:1706.03762', 'paper:new']]),
    );

    expect(before[0].to).toBe('ext:s2-1');
    expect(after[0].to).toBe('paper:new');
  });

  it('emits nothing when the parent paper is not on screen', () => {
    expect(edgesFrom({ p1: expansion() }, ['ext:s2-1'])).toEqual([]);
  });
});

describe('pruneExpansions', () => {
  // Half an expansion is a lie the UI cannot detect: it would show "40
  // references" that is silently 12, with nothing saying which 28 are missing.
  it('evicts whole expansions, oldest first, never a partial list', () => {
    const many = (n: number, id: string, at: number) =>
      expansion({
        paperId: id,
        fetchedAt: at,
        papers: Array.from({ length: n }, (_, i) => ext({ s2Id: `${id}-${i}` })),
      });

    const pruned = pruneExpansions(
      { old: many(10, 'old', NOW - 1000), fresh: many(10, 'fresh', NOW) },
      12,
    );

    expect(Object.keys(pruned)).toEqual(['fresh']);
    expect(pruned.fresh.papers).toHaveLength(10);
  });

  it('leaves everything alone below the cap', () => {
    const stored = { p1: expansion() };

    expect(pruneExpansions(stored, 100)).toBe(stored);
  });
});

describe('readingQueue', () => {
  const cite = (from: string, to: string) => ({
    from,
    to,
    source: 'openalex' as const,
    fetchedAt: NOW,
  });

  it('surfaces a work three of your papers converge on', () => {
    const queue = readingQueue([
      cite('paper:a', 'ext:foundational'),
      cite('paper:b', 'ext:foundational'),
      cite('paper:c', 'ext:foundational'),
    ]);

    expect(queue).toEqual([{ id: 'ext:foundational', owners: 3 }]);
  });

  // Two is a coincidence between deck-mates; three is a pattern.
  it('stays quiet below the threshold', () => {
    expect(
      readingQueue([cite('paper:a', 'ext:x'), cite('paper:b', 'ext:x')]),
    ).toEqual([]);
  });

  // Counting edges rather than citing papers would let one expansion listing a
  // work twice promote it on its own.
  it('counts distinct citing papers, not arrows', () => {
    const queue = readingQueue([
      cite('paper:a', 'ext:x'),
      cite('paper:a', 'ext:x'),
      cite('paper:a', 'ext:x'),
    ]);

    expect(queue).toEqual([]);
  });

  it('ignores papers you already have — the queue is what you are missing', () => {
    const queue = readingQueue([
      cite('paper:a', 'paper:mine'),
      cite('paper:b', 'paper:mine'),
      cite('paper:c', 'paper:mine'),
    ]);

    expect(queue).toEqual([]);
  });

  it('ignores arrows out of a borrowed paper, which are not your reading', () => {
    const queue = readingQueue([
      cite('ext:a', 'ext:target'),
      cite('ext:b', 'ext:target'),
      cite('ext:c', 'ext:target'),
    ]);

    expect(queue).toEqual([]);
  });

  it('ranks the most-converged-on first', () => {
    const queue = readingQueue([
      cite('paper:a', 'ext:some'),
      cite('paper:b', 'ext:some'),
      cite('paper:c', 'ext:some'),
      cite('paper:a', 'ext:many'),
      cite('paper:b', 'ext:many'),
      cite('paper:c', 'ext:many'),
      cite('paper:d', 'ext:many'),
    ]);

    expect(queue.map((q) => q.id)).toEqual(['ext:many', 'ext:some']);
  });
});
