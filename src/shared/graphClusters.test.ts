import { describe, expect, it } from 'vitest';
import { GRAPH_CLUSTER_MAX } from './constants';
import { anchorTopics, assignClusters, buildClusters, OTHER_CLUSTER } from './graphClusters';
import type { GraphEdge } from './graphModel';
import type { GraphNode } from './types';

const NOW = 1_700_000_000_000;

function node(id: string, tags: string[] = []): GraphNode {
  return {
    id,
    kind: 'article',
    title: id,
    url: `https://example.com/${id}`,
    source: '',
    tags,
    tagSource: 'ai',
    tagInputHash: 'h',
    completion: 0,
    firstSeenAt: NOW,
    updatedAt: NOW,
  };
}

function edge(a: string, b: string, weight = 1): GraphEdge {
  return { a, b, weight, reasons: ['tag'] };
}

describe('anchorTopics', () => {
  // A neighbourhood of one is not a neighbourhood — it is a labelled dot, and
  // forty of those is the hairball again with more text on it.
  it('ignores a topic only one node carries', () => {
    const nodes = [node('a', ['rlhf']), node('b', ['rlhf']), node('c', ['one off'])];

    expect(anchorTopics(nodes)).toEqual(['rlhf']);
  });

  it('caps how many regions the map is divided into', () => {
    const nodes = Array.from({ length: 40 }, (_, i) => node(`n${i}`, [`topic ${i % 20}`]));

    expect(anchorTopics(nodes)).toHaveLength(GRAPH_CLUSTER_MAX);
  });

  it('takes the most-used topics first', () => {
    const nodes = [
      node('a', ['common']),
      node('b', ['common']),
      node('c', ['common']),
      node('d', ['rarer']),
      node('e', ['rarer']),
    ];

    expect(anchorTopics(nodes, 1)).toEqual(['common']);
  });
});

describe('assignClusters', () => {
  // Joining the most common topic instead would drag everything into one giant
  // "machine learning" region, which is the blob this exists to break up.
  it('sends a node to its most specific topic, not its broadest', () => {
    const nodes = [
      node('a', ['machine learning', 'speculative decoding']),
      node('b', ['machine learning']),
      node('c', ['machine learning']),
      node('d', ['speculative decoding']),
    ];
    const anchors = anchorTopics(nodes);

    expect(assignClusters(nodes, [], anchors).get('a')).toBe('speculative decoding');
  });

  it('pulls an untagged node into the region it is linked to', () => {
    const nodes = [node('a', ['rlhf']), node('b', ['rlhf']), node('untagged')];
    const clusters = assignClusters(nodes, [edge('a', 'untagged')], anchorTopics(nodes));

    expect(clusters.get('untagged')).toBe('rlhf');
  });

  it('follows the strongest link when a node touches two regions', () => {
    const nodes = [
      node('a', ['rlhf']),
      node('b', ['rlhf']),
      node('c', ['diffusion']),
      node('d', ['diffusion']),
      node('untagged'),
    ];
    const edges = [edge('a', 'untagged', 0.4), edge('c', 'untagged', 0.9)];

    expect(assignClusters(nodes, edges, anchorTopics(nodes)).get('untagged')).toBe('diffusion');
  });

  it('puts a node with no topic and no links in the leftovers bin', () => {
    const nodes = [node('a', ['rlhf']), node('b', ['rlhf']), node('lonely')];

    expect(assignClusters(nodes, [], anchorTopics(nodes)).get('lonely')).toBe(OTHER_CLUSTER);
  });

  it('gives every node a home', () => {
    const nodes = [node('a', ['rlhf']), node('b', ['rlhf']), node('c'), node('d', ['unique'])];
    const clusters = assignClusters(nodes, [], anchorTopics(nodes));

    for (const n of nodes) expect(clusters.get(n.id)).toBeTruthy();
  });
});

describe('buildClusters', () => {
  function library() {
    return [
      node('a', ['rlhf']),
      node('b', ['rlhf']),
      node('c', ['rlhf']),
      node('d', ['diffusion']),
      node('e', ['diffusion']),
      node('f'),
    ];
  }

  it('gives every region a distinct centre', () => {
    const { centres, keys } = buildClusters(library(), []);
    const seen = new Set(keys.map((k) => `${centres.get(k)!.x},${centres.get(k)!.y}`));

    expect(seen.size).toBe(keys.length);
  });

  // The map has to be the same map every time it opens, or there is nothing to
  // remember and every visit is a fresh search.
  it('places the same library identically on every build', () => {
    const first = buildClusters(library(), []);
    const second = buildClusters(library(), []);

    expect([...second.centres]).toEqual([...first.centres]);
    expect(second.keys).toEqual(first.keys);
  });

  // "Everything else" is a leftovers bin, not a subject. Sorting it by size
  // would put it at the centre of the map whenever it happened to be biggest.
  it('never seats the leftovers bin at the centre', () => {
    const crowded = [
      ...Array.from({ length: 9 }, (_, i) => node(`x${i}`)),
      node('a', ['rlhf']),
      node('b', ['rlhf']),
    ];

    expect(buildClusters(crowded, []).keys[0]).not.toBe(OTHER_CLUSTER);
  });

  it('counts the members of each region', () => {
    const { sizes } = buildClusters(library(), []);

    expect(sizes.get('rlhf')).toBe(3);
    expect(sizes.get('diffusion')).toBe(2);
  });
});
