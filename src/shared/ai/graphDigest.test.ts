import { describe, expect, it } from 'vitest';
import {
  describeVisible,
  groupByTopic,
  visibleSources,
  type VisibleGraph,
  type VisibleNode,
} from './graphDigest';

const NOW = 1_700_000_000_000;

function n(over: Partial<VisibleNode> & { id: string }): VisibleNode {
  return {
    title: over.id,
    kind: 'paper',
    url: `https://example.com/${over.id}`,
    topics: [],
    read: 0,
    ...over,
  };
}

function visible(over: Partial<VisibleGraph> = {}): VisibleGraph {
  return {
    nodes: [],
    cites: [],
    selectedId: '',
    topic: '',
    updatedAt: NOW,
    publisherId: 'p',
    ...over,
  };
}

describe('groupByTopic', () => {
  it('puts a node in every topic it carries, biggest group first', () => {
    const nodes = [
      n({ id: 'a', topics: ['rlhf', 'alignment'] }),
      n({ id: 'b', topics: ['rlhf'] }),
      n({ id: 'c', topics: ['alignment'] }),
      n({ id: 'd', topics: ['rlhf'] }),
    ];

    expect(groupByTopic(nodes).map(([t, m]) => [t, m.length])).toEqual([
      ['rlhf', 3],
      ['alignment', 2],
    ]);
  });

  it('counts a node once even if it repeats a topic', () => {
    expect(groupByTopic([n({ id: 'a', topics: ['rlhf', 'rlhf'] })])[0][1]).toHaveLength(1);
  });
});

describe('describeVisible', () => {
  const library = () =>
    visible({
      nodes: [
        n({ id: 'a', title: 'InstructGPT', topics: ['rlhf'], read: 1 }),
        n({ id: 'b', title: 'DPO', topics: ['rlhf'], read: 0.2 }),
        n({ id: 'c', title: 'DDPM', topics: ['diffusion'], read: 0 }),
        n({ id: 'd', title: 'Latent Diffusion', topics: ['diffusion'], read: 0 }),
      ],
    });

  it('counts what is on screen and how much is finished', () => {
    const text = describeVisible(library());

    expect(text).toContain('4 things on the graph');
    expect(text).toContain('1 finished, 3 not');
  });

  it('reports each topic with how much of it is done', () => {
    const text = describeVisible(library());

    expect(text).toContain('- rlhf: 2 things, 1 finished');
    expect(text).toContain('- diffusion: 2 things, 0 finished');
  });

  // The observation a reader wants and would otherwise have to derive by eye.
  it('names a subject with nothing finished in it', () => {
    expect(describeVisible(library())).toContain('Nothing finished yet in: diffusion');
  });

  it('names the selection when there is one', () => {
    const text = describeVisible(visible({ ...library(), selectedId: 'c' }));

    expect(text).toContain('Selected: DDPM');
  });

  it('reports citations between things on screen, by title', () => {
    const text = describeVisible(visible({ ...library(), cites: [['a', 'b']] }));

    expect(text).toContain('InstructGPT → DPO');
  });

  // A citation to something scrolled off or filtered out is not a fact about
  // this view, and quoting it would describe a screen nobody is looking at.
  it('drops a citation whose other end is not on screen', () => {
    const text = describeVisible(visible({ ...library(), cites: [['a', 'offscreen']] }));

    expect(text).not.toContain('Citations between');
  });

  it('says the filter is in force when one is', () => {
    const text = describeVisible(visible({ ...library(), topic: 'rlhf' }));

    expect(text).toContain('under “rlhf”');
  });

  it('says plainly when a filter is showing nothing', () => {
    expect(describeVisible(visible({ topic: 'rlhf' }))).toBe('Nothing is showing under “rlhf”.');
  });

  it('flags things carrying no topic yet', () => {
    const text = describeVisible(visible({ nodes: [n({ id: 'a' }), n({ id: 'b' })] }));

    expect(text).toContain('2 things have no topic yet');
  });
});

// Captured verbatim from what the graph page wrote to session storage. Both
// sides of this were already unit-tested; the seam between them was not, and
// "publisher and reader each pass their own tests while disagreeing about the
// shape" is exactly the failure that survives that.
describe('the payload the page actually publishes', () => {
  const captured = {
    cites: [],
    nodes: [
      {
        id: 'paper:p1',
        kind: 'paper' as const,
        read: 1,
        title: 'InstructGPT',
        topics: ['rlhf'],
        url: 'https://arxiv.org/abs/2203.02155',
      },
      {
        id: 'paper:p2',
        kind: 'paper' as const,
        read: 0,
        title: 'DPO',
        topics: ['rlhf'],
        url: 'https://arxiv.org/abs/2305.18290',
      },
    ],
    publisherId: '9b1e94ad-d273-4400-a77a-ed2f6a538000',
    selectedId: 'paper:p1',
    topic: '',
    updatedAt: 1785212698123,
  };

  it('describes correctly', () => {
    const text = describeVisible(captured);

    expect(text).toContain('2 things on the graph; 1 finished, 1 not');
    expect(text).toContain('Selected: InstructGPT');
    expect(text).toContain('- rlhf: 2 things, 1 finished');
  });

  it('cites both papers, because both were on screen', () => {
    expect(visibleSources(captured).map((s) => s.title)).toEqual(['InstructGPT', 'DPO']);
  });
});

describe('visibleSources', () => {
  // Minted from the digest rather than parsed out of prose, so a cited item is
  // always something that was genuinely on screen.
  it('cites only nodes that have somewhere to go', () => {
    const nodes = [n({ id: 'a', title: 'Has a link' }), n({ id: 'b', url: '' })];

    expect(visibleSources(visible({ nodes })).map((s) => s.title)).toEqual(['Has a link']);
  });

  it('maps graph kinds onto citation kinds', () => {
    const nodes = [
      n({ id: 'a', kind: 'paper' }),
      n({ id: 'b', kind: 'note' }),
      n({ id: 'c', kind: 'video' }),
      n({ id: 'd', kind: 'external' }),
    ];

    expect(visibleSources(visible({ nodes })).map((s) => s.kind)).toEqual([
      'paper',
      'note',
      'page',
      'paper',
    ]);
  });
});
