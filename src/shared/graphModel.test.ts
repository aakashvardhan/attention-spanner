import { describe, expect, it } from 'vitest';
import { GRAPH_EDGE_MIN_WEIGHT, GRAPH_HUB_TAG_NODES } from './constants';
import {
  buildGraph,
  heatLevel,
  liveNodes,
  neighborsOf,
  tagWeight,
  type LiveIndex,
} from './graphModel';
import type { CitationExpansion, ExternalPaper } from './citations';
import { paperMatchKey } from './papers';
import type { Recording } from './recordings';
import type { Annotation, GraphNode, GraphNodeKind } from './types';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function node(id: string, kind: GraphNodeKind, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind,
    title: id,
    url: `https://example.com/${id}`,
    source: '',
    tags: [],
    tagSource: 'auto',
    tagInputHash: '',
    completion: 0,
    firstSeenAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

function index(over: Partial<LiveIndex> = {}): LiveIndex {
  return {
    paperIds: new Set(),
    bookmarkIds: new Set(),
    recordings: [],
    annotations: [],
    ...over,
  };
}

function recording(id: string, source: Recording['source']): Recording {
  return {
    id,
    title: id,
    source,
    startedAt: NOW,
    durationSeconds: 60,
    status: 'ready',
    segments: [],
    summary: '',
    actionItems: [],
    error: '',
    updatedAt: NOW,
  };
}

function annotation(paperId: string, docUrl: string): Annotation {
  return {
    id: `${paperId}-a`,
    docKey: docUrl,
    docUrl,
    paperId,
    kind: 'highlight',
    anchor: { kind: 'text', blockIndex: 0, quote: 'q', prefix: '', suffix: '' },
    text: 'q',
    color: 'yellow',
    note: '',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** A cited work, named so the node id it implies is readable in the assertions. */
function cited(id: string, relation: ExternalPaper['relation'] = 'reference'): ExternalPaper {
  return {
    s2Id: id,
    title: id,
    authors: '',
    venue: '',
    year: 2020,
    citations: null,
    url: `https://example.com/${id}`,
    matchKey: null,
    topics: [],
    relation,
  };
}

function expansionOf(papers: ExternalPaper[], paperId = 'p1'): CitationExpansion {
  return {
    paperId,
    fetchedAt: NOW,
    papers,
    partial: false,
    note: '',
    sources: { references: 'openalex', citations: 'openalex' },
  };
}

function build(nodes: GraphNode[], live = index(), renderCap?: number) {
  return buildGraph(nodes, live, { now: NOW, renderCap });
}

function edgeBetween(model: ReturnType<typeof build>, a: string, b: string) {
  return model.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
}

describe('liveNodes', () => {
  it('drops record-backed nodes whose record is gone', () => {
    const nodes = [
      node('paper:p1', 'paper'),
      node('paper:dead', 'paper'),
      node('bm:b1', 'bookmark'),
      node('bm:dead', 'bookmark'),
      node('recording:r1', 'recording'),
      node('recording:dead', 'recording'),
    ];
    const live = index({
      paperIds: new Set(['p1']),
      bookmarkIds: new Set(['b1']),
      recordings: [recording('r1', { kind: 'mic' })],
    });

    expect(liveNodes(nodes, live).map((n) => n.id)).toEqual(['paper:p1', 'bm:b1', 'recording:r1']);
  });

  // The regression that would silently gut the feature: readingProgress is
  // pruned at 100 entries, so outliving it is the whole point of storing the
  // node. Filtering on it would cap the graph at the last 100 things read.
  it('keeps article and video nodes with no surviving progress entry', () => {
    const nodes = [node('example.com/old', 'article'), node('yt:abc', 'video')];

    expect(liveNodes(nodes, index())).toHaveLength(2);
  });
});

describe('buildGraph — structural edges', () => {
  it('links papers sharing a deck at full weight', () => {
    const nodes = [
      node('paper:p1', 'paper', { deckId: 'd1' }),
      node('paper:p2', 'paper', { deckId: 'd1' }),
      node('paper:p3', 'paper', { deckId: 'd2' }),
    ];
    const model = build(nodes, index({ paperIds: new Set(['p1', 'p2', 'p3']) }));

    expect(edgeBetween(model, 'paper:p1', 'paper:p2')).toMatchObject({
      weight: 1,
      reasons: ['deck'],
    });
    expect(edgeBetween(model, 'paper:p1', 'paper:p3')).toBeUndefined();
  });

  it('links bookmarks sharing a group, but not ungrouped ones', () => {
    const nodes = [
      node('bm:b1', 'bookmark', { groupId: 'g1' }),
      node('bm:b2', 'bookmark', { groupId: 'g1' }),
      node('bm:b3', 'bookmark', { groupId: null }),
      node('bm:b4', 'bookmark', { groupId: null }),
    ];
    const model = build(nodes, index({ bookmarkIds: new Set(['b1', 'b2', 'b3', 'b4']) }));

    expect(edgeBetween(model, 'bm:b1', 'bm:b2')?.reasons).toContain('group');
    // Unsorted is not a group — "neither of these is filed" is not a relationship
    expect(edgeBetween(model, 'bm:b3', 'bm:b4')).toBeUndefined();
  });

  it('links a YouTube recording to the video it transcribes', () => {
    const nodes = [node('recording:r1', 'recording'), node('yt:abc123', 'video')];
    const live = index({ recordings: [recording('r1', { kind: 'youtube', videoId: 'abc123' })] });
    const model = build(nodes, live);

    expect(edgeBetween(model, 'recording:r1', 'yt:abc123')).toMatchObject({
      weight: 1,
      reasons: ['video'],
    });
  });

  it('links a tab recording to the article it was captured from', () => {
    const nodes = [node('recording:r1', 'recording'), node('news.site/piece', 'article')];
    const live = index({
      recordings: [
        recording('r1', {
          kind: 'tab',
          tabUrl: 'https://www.news.site/piece/?utm_source=x',
          tabTitle: 'Piece',
        }),
      ],
    });

    expect(edgeBetween(build(nodes, live), 'recording:r1', 'news.site/piece')).toBeDefined();
  });

  it('bridges a paper and the page it was highlighted on', () => {
    const nodes = [node('paper:p1', 'paper'), node('arxiv.org/abs/1', 'article')];
    const live = index({
      paperIds: new Set(['p1']),
      annotations: [annotation('p1', 'https://arxiv.org/abs/1')],
    });

    expect(edgeBetween(build(nodes, live), 'paper:p1', 'arxiv.org/abs/1')).toMatchObject({
      weight: 0.8,
      reasons: ['annotation'],
    });
  });
});

describe('buildGraph — hairball control', () => {
  it('suppresses a domain once it is a hub', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      node(`bm:b${i}`, 'bookmark', { url: 'https://news.ycombinator.com/item?id=' + i }),
    );
    const model = build(many, index({ bookmarkIds: new Set(many.map((n) => n.id.slice(3))) }));

    expect(model.edges).toHaveLength(0);
  });

  it('keeps a domain edge below the hub threshold', () => {
    const few = Array.from({ length: 3 }, (_, i) =>
      node(`bm:b${i}`, 'bookmark', { url: `https://blog.dev/post-${i}`, groupId: null }),
    );
    const model = build(few, index({ bookmarkIds: new Set(few.map((n) => n.id.slice(3))) }));

    // 0.2 is below GRAPH_EDGE_MIN_WEIGHT on its own, so a bare shared domain
    // never draws a line — it only counts when it stacks with something else.
    expect(model.edges).toHaveLength(0);
  });

  it('bounds each node to GRAPH_TOP_K edges in a large clique', () => {
    const deck = Array.from({ length: 20 }, (_, i) => node(`paper:p${i}`, 'paper', { deckId: 'd' }));
    const model = build(deck, index({ paperIds: new Set(deck.map((n) => n.id.slice(6))) }));

    // 20 papers would be 190 edges unpruned; top-K keeps the graph readable
    // while leaving every node connected.
    expect(model.edges.length).toBeLessThan(190);
    for (const n of model.nodes) expect(n.degree).toBeGreaterThan(0);
  });

  it('narrows to the render cap by degree, then recency', () => {
    const linked = [
      node('paper:p1', 'paper', { deckId: 'd', updatedAt: NOW - 10 * DAY }),
      node('paper:p2', 'paper', { deckId: 'd', updatedAt: NOW - 10 * DAY }),
    ];
    const lonely = node('example.com/lonely', 'article', { updatedAt: NOW });
    const model = build([lonely, ...linked], index({ paperIds: new Set(['p1', 'p2']) }), 2);

    expect(model.nodes.map((n) => n.id).sort()).toEqual(['paper:p1', 'paper:p2']);
    expect(model.totalNodes).toBe(3);
  });

  it('never reports a degree for a connection the cap hid', () => {
    const deck = Array.from({ length: 4 }, (_, i) => node(`paper:p${i}`, 'paper', { deckId: 'd' }));
    const model = build(deck, index({ paperIds: new Set(deck.map((n) => n.id.slice(6))) }), 2);

    expect(model.nodes).toHaveLength(2);
    for (const n of model.nodes) expect(n.degree).toBe(model.edges.length);
  });
});

describe('heatLevel', () => {
  it('leaves an unopened node cold', () => {
    expect(heatLevel(node('bm:b1', 'bookmark'), NOW)).toBe(0);
  });

  it('burns brightest for something just finished', () => {
    expect(heatLevel(node('a', 'article', { completion: 1, updatedAt: NOW }), NOW)).toBe(4);
  });

  it('fades the same completion as it ages', () => {
    const old = node('a', 'article', { completion: 1, updatedAt: NOW - 200 * DAY });
    const recent = node('b', 'article', { completion: 1, updatedAt: NOW - DAY });

    expect(heatLevel(old, NOW)).toBeLessThan(heatLevel(recent, NOW));
  });
});

describe('tag edges', () => {
  const tagged = (nodes: GraphNode[], a: string, b: string) =>
    edgeBetween(build(nodes, index()), a, b);

  it('links two things that share a topic', () => {
    const nodes = [
      node('a', 'article', { tags: ['diffusion models'] }),
      node('b', 'article', { tags: ['diffusion models'] }),
    ];

    expect(tagged(nodes, 'a', 'b')?.reasons).toContain('tag');
  });

  it('does not link things whose topics merely overlap in spelling', () => {
    const nodes = [
      node('a', 'article', { tags: ['diffusion models'] }),
      node('b', 'article', { tags: ['diffusion'] }),
    ];

    expect(tagged(nodes, 'a', 'b')).toBeUndefined();
  });

  // One broad label on eighty nodes is 3,160 pairs to build before anything
  // filters them, and a hairball that owns the layout if they survive. A topic
  // that broad is a filter, not a relationship.
  it('emits nothing for a topic carried by more nodes than the hub cap', () => {
    const nodes = Array.from({ length: GRAPH_HUB_TAG_NODES + 1 }, (_, i) =>
      node(`n${i}`, 'article', { tags: ['machine learning'], url: `https://a${i}.test/x` }),
    );

    expect(build(nodes, index()).edges).toEqual([]);
  });

  // The cap and the weight ramp do different jobs: the ramp has already taken
  // a broad topic below the drawing threshold long before the cap, so the cap
  // is purely a cost guard. What still separates the two sides of it is
  // whether the topic contributes at all when stacked on another reason.
  it('lets a topic on the hub cap still strengthen an edge it stacks with', () => {
    // Two of the tagged nodes also share a site; the rest are each on their
    // own host, so the domain group stays far below its own hub cap while the
    // topic crosses its one.
    const spread = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        node(`n${i}`, 'article', {
          tags: ['machine learning'],
          url: i < 2 ? `https://same.test/${i}` : `https://host${i}.test/x`,
        }),
      );

    const onCap = tagged(spread(GRAPH_HUB_TAG_NODES), 'n0', 'n1');
    const overCap = tagged(spread(GRAPH_HUB_TAG_NODES + 1), 'n0', 'n1');

    expect(onCap?.reasons).toEqual(expect.arrayContaining(['tag', 'domain']));
    // Over the cap the topic contributes nothing, and a bare shared site is
    // below the drawing threshold on its own — so the edge disappears.
    expect(overCap).toBeUndefined();
  });

  it('weights a rare shared topic above a common one', () => {
    expect(tagWeight(2)).toBeGreaterThan(tagWeight(6));
    expect(tagWeight(6)).toBeGreaterThan(tagWeight(GRAPH_HUB_TAG_NODES));
  });

  // Past about seven nodes a topic stops being a claim about any two of them.
  // It should fade out rather than fall off a cliff at the hub cap, so it only
  // counts when it stacks with another reason — exactly like `domain`.
  it('lets a broad topic fall below the drawing threshold on its own', () => {
    const nodes = Array.from({ length: 8 }, (_, i) =>
      node(`n${i}`, 'article', { tags: ['machine learning'], url: `https://a${i}.test/x` }),
    );

    expect(tagWeight(8)).toBeLessThan(GRAPH_EDGE_MIN_WEIGHT);
    expect(build(nodes, index()).edges).toEqual([]);
  });

  it('stacks a shared topic with a shared site into one stronger edge', () => {
    const nodes = [
      node('a', 'article', { tags: ['sleep research'], url: 'https://same.test/1' }),
      node('b', 'article', { tags: ['sleep research'], url: 'https://same.test/2' }),
    ];
    const edge = tagged(nodes, 'a', 'b');

    expect(edge?.reasons).toEqual(expect.arrayContaining(['tag', 'domain']));
    expect(edge?.weight).toBeCloseTo(tagWeight(2) + 0.2);
  });
});

describe('buildGraph — stable arrangement', () => {
  /**
   * Spatial memory is the whole point of a map, and this is what used to break
   * it. seedLayout indexes a spiral by position in `model.nodes`, so that array
   * order *is* the layout — and it was sorted by `updatedAt`, which means
   * reading one article re-indexed everything after it and the map you learned
   * yesterday was a different map today.
   */
  it('does not reorder when something is read', () => {
    // Two deck-mates, so their degree is equal and `updatedAt` was the only
    // thing separating them — which is exactly the pair the old sort swapped
    // the moment either one was opened.
    const nodes = [
      node('paper:p1', 'paper', {
        deckId: 'd',
        firstSeenAt: NOW - 30 * DAY,
        updatedAt: NOW - 30 * DAY,
      }),
      node('paper:p2', 'paper', {
        deckId: 'd',
        firstSeenAt: NOW - 20 * DAY,
        updatedAt: NOW - 20 * DAY,
      }),
    ];
    const live = index({ paperIds: new Set(['p1', 'p2']) });

    const before = build(nodes, live).nodes.map((n) => n.id);
    // The older paper is opened again: newest by updatedAt, unchanged by
    // firstSeenAt. Under the old sort this alone flipped the two.
    const touched = nodes.map((n) =>
      n.id === 'paper:p1' ? { ...n, updatedAt: NOW + DAY, completion: 0.5 } : n,
    );
    const after = build(touched, live).nodes.map((n) => n.id);

    expect(before).toEqual(['paper:p1', 'paper:p2']);
    expect(after).toEqual(before);
  });

  it('appends a newly seen node rather than displacing the arrangement', () => {
    const existing = [
      node('paper:p1', 'paper', { deckId: 'd', firstSeenAt: NOW - 30 * DAY }),
      node('paper:p2', 'paper', { deckId: 'd', firstSeenAt: NOW - 20 * DAY }),
    ];
    const live = index({ paperIds: new Set(['p1', 'p2', 'p3']) });

    const before = build(existing, live).nodes.map((n) => n.id);
    const after = build(
      [...existing, node('paper:p3', 'paper', { deckId: 'd', firstSeenAt: NOW })],
      live,
    ).nodes.map((n) => n.id);

    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)).toBe('paper:p3');
  });

  it('breaks a tie on id, so two things seen at once still land somewhere fixed', () => {
    const same = { deckId: 'd', firstSeenAt: NOW };
    const live = index({ paperIds: new Set(['a', 'b']) });
    const forward = build([node('paper:a', 'paper', same), node('paper:b', 'paper', same)], live);
    const reversed = build([node('paper:b', 'paper', same), node('paper:a', 'paper', same)], live);

    expect(forward.nodes.map((n) => n.id)).toEqual(reversed.nodes.map((n) => n.id));
  });
});

describe('buildGraph — citation edges', () => {
  it('keeps direction out of the expansion and into the model', () => {
    const nodes = [node('paper:p1', 'paper'), node('ext:older', 'external')];
    const model = build(
      nodes,
      index({ paperIds: new Set(['p1']), citations: { p1: expansionOf([cited('older')]) } }),
    );

    expect(model.cites).toMatchObject([{ from: 'paper:p1', to: 'ext:older' }]);
    // The similarity list must never learn about it.
    expect(model.edges).toHaveLength(0);
  });

  it('runs the arrow inward for a work that cites the paper', () => {
    const nodes = [node('paper:p1', 'paper'), node('ext:newer', 'external')];
    const model = build(
      nodes,
      index({
        paperIds: new Set(['p1']),
        citations: { p1: expansionOf([cited('newer', 'citation')]) },
      }),
    );

    expect(model.cites).toMatchObject([{ from: 'ext:newer', to: 'paper:p1' }]);
  });

  /**
   * The reason `cites` is exempt from topK, in the exact shape that used to
   * break it — a foundational work every paper in a deck builds on.
   *
   * Under the shared budget both ends are saturated at once. Each paper's six
   * slots go to deck-mates (weight 1, against a citation's 0.6), and the
   * foundational work has more citations than slots, so the union rule cannot
   * rescue them either: three of the nine arrows used to vanish, and which
   * three depended on iteration order. That is precisely the lineage the view
   * exists to show, thrown away to make room for a filing decision.
   */
  it('keeps every arrow into a work the whole deck builds on', () => {
    const deck = Array.from({ length: 9 }, (_, i) => node(`paper:p${i}`, 'paper', { deckId: 'd' }));
    const citations = Object.fromEntries(
      deck.map((n) => {
        const id = n.id.slice('paper:'.length);
        return [id, expansionOf([cited('foundational')], id)];
      }),
    );
    const model = build(
      [...deck, node('ext:foundational', 'external')],
      index({ paperIds: new Set(deck.map((n) => n.id.slice('paper:'.length))), citations }),
    );

    expect(model.cites).toHaveLength(9);
    expect(model.nodes.find((n) => n.id === 'ext:foundational')?.degree).toBe(9);
  });

  it('counts a citation toward degree, so a much-cited work reads as a hub', () => {
    const nodes = [
      node('paper:p1', 'paper'),
      node('paper:p2', 'paper'),
      node('ext:shared', 'external'),
    ];
    const model = build(
      nodes,
      index({
        paperIds: new Set(['p1', 'p2']),
        citations: {
          p1: expansionOf([cited('shared')]),
          p2: expansionOf([cited('shared')], 'p2'),
        },
      }),
    );

    expect(model.nodes.find((n) => n.id === 'ext:shared')?.degree).toBe(2);
  });

  it('drops a citation whose other end the render cap hid', () => {
    const nodes = [node('paper:p1', 'paper'), node('ext:gone', 'external')];
    const model = build(
      nodes,
      index({ paperIds: new Set(['p1']), citations: { p1: expansionOf([cited('gone')]) } }),
      1,
    );

    expect(model.nodes).toHaveLength(1);
    expect(model.cites).toEqual([]);
  });
});

describe('buildGraph — the recording bridge', () => {
  /**
   * The whole point of routing this through recordings, and the claim worth a
   * test of its own: nothing links a *video* to a paper directly, because a
   * video stores no text to scan. What exists is a recording that names the
   * paper and is already joined to the video it was captured from — so the
   * connection arrives in two hops that were both already there.
   */
  it('reaches a paper from the video, through the recording of it', () => {
    const nodes = [
      node('yt:abc', 'video', { videoId: 'abc' }),
      node('recording:r1', 'recording'),
      node('paper:ddpm', 'paper'),
    ];
    const live = index({
      paperIds: new Set(['ddpm']),
      recordings: [
        {
          ...recording('r1', { kind: 'youtube', videoId: 'abc' }),
          segments: [{ startSec: 42, endSec: 60, text: 'the paper is arXiv:2006.11239' }],
        },
      ],
      paperNodeByKey: new Map([[paperMatchKey('https://arxiv.org/abs/2006.11239')!, 'paper:ddpm']]),
    });
    const model = build(nodes, live);

    // Hop one already existed: the recording and the video it came from.
    expect(edgeBetween(model, 'recording:r1', 'yt:abc')?.reasons).toContain('video');
    // Hop two is the new one, and it carries its own evidence.
    expect(model.mentions).toMatchObject([
      { from: 'recording:r1', to: 'paper:ddpm', atSec: 42 },
    ]);
    expect(model.mentions[0].evidence).toContain('arXiv:2006.11239');
  });

  it('never lets a mention leak into the similarity or citation lists', () => {
    const nodes = [node('recording:r1', 'recording'), node('paper:ddpm', 'paper')];
    const model = build(
      nodes,
      index({
        paperIds: new Set(['ddpm']),
        recordings: [
          {
            ...recording('r1', { kind: 'mic' }),
            segments: [{ startSec: 0, endSec: 10, text: 'arXiv:2006.11239' }],
          },
        ],
        paperNodeByKey: new Map([[paperMatchKey('https://arxiv.org/abs/2006.11239')!, 'paper:ddpm']]),
      }),
    );

    expect(model.mentions).toHaveLength(1);
    expect(model.cites).toEqual([]);
    expect(model.edges).toEqual([]);
  });
});

describe('neighborsOf', () => {
  it('reports which way a citation runs', () => {
    const nodes = [
      node('paper:p1', 'paper'),
      node('ext:older', 'external'),
      node('ext:newer', 'external'),
    ];
    const model = build(
      nodes,
      index({
        paperIds: new Set(['p1']),
        citations: { p1: expansionOf([cited('older'), cited('newer', 'citation')]) },
      }),
    );

    expect(neighborsOf(model, 'paper:p1').map((n) => [n.node.id, n.cites])).toEqual([
      ['ext:older', 'builds-on'],
      ['ext:newer', 'cited-by'],
    ]);
  });

  it('names each neighbour and why, strongest first', () => {
    const nodes = [
      node('paper:p1', 'paper', { deckId: 'd' }),
      node('paper:p2', 'paper', { deckId: 'd' }),
      node('arxiv.org/abs/1', 'article'),
    ];
    const live = index({
      paperIds: new Set(['p1', 'p2']),
      annotations: [annotation('p1', 'https://arxiv.org/abs/1')],
    });
    const found = neighborsOf(build(nodes, live), 'paper:p1');

    expect(found.map((n) => [n.node.id, n.reasons[0]])).toEqual([
      ['paper:p2', 'deck'],
      ['arxiv.org/abs/1', 'annotation'],
    ]);
  });
});
