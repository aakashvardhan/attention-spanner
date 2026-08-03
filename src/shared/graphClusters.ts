import { GRAPH_CLUSTER_MAX, GRAPH_CLUSTER_SPACING } from './constants';
import type { GraphEdge } from './graphModel';
import type { GraphNode } from './types';

/**
 * Giving the graph geography.
 *
 * A force layout on its own produces one blob: it knows which nodes are linked
 * but nothing about what they are *about*, so everything competes for the same
 * middle. Topics fix that — each becomes a neighbourhood with a fixed place on
 * the page, so the map has a small number of named regions to scan instead of
 * one field of dots.
 *
 * Pure and deterministic, like graphLayout.ts: the same library must produce
 * the same map every time it is opened, or none of it can be remembered.
 */

export interface ClusterLayout {
  /** node id → cluster key; every node in the input gets one */
  byNode: Map<string, string>;
  /** cluster key → its centre in layout space */
  centres: Map<string, { x: number; y: number }>;
  /** Cluster keys, largest first — the order centres are assigned in */
  keys: string[];
  /** cluster key → how many nodes it holds */
  sizes: Map<string, number>;
}

/** Where an untagged node ends up when nothing it links to has a topic either. */
export const OTHER_CLUSTER = 'everything else';

const GOLDEN_ANGLE = 2.399963229728653;

/**
 * The topics worth making a neighbourhood of: the most-used ones, capped.
 *
 * A cluster of one is not a neighbourhood, and forty of them is the hairball
 * again with extra labels — so the cap is doing real work. Ties break
 * alphabetically to keep the whole thing deterministic.
 */
export function anchorTopics(nodes: readonly GraphNode[], max = GRAPH_CLUSTER_MAX): string[] {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    for (const tag of new Set(node.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([tag]) => tag);
}

/**
 * Which neighbourhood each node belongs to.
 *
 * A node carrying several anchor topics joins the *rarest* of them. Joining the
 * most common instead would pull everything into one giant "machine learning"
 * region, which is the blob we are trying to get rid of — the more specific
 * label is the one that actually says where a thing belongs.
 *
 * An untagged node joins whichever neighbourhood it is most strongly linked to,
 * so a paper filed in a deck sits with its deck rather than in exile.
 */
export function assignClusters(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  anchors: readonly string[],
): Map<string, string> {
  const rank = new Map(anchors.map((tag, i) => [tag, i]));
  const byNode = new Map<string, string>();
  const unassigned: string[] = [];

  for (const node of nodes) {
    // anchors are ordered most-common first, so the largest index is the rarest
    let best = '';
    let bestRank = -1;
    for (const tag of node.tags) {
      const r = rank.get(tag);
      if (r !== undefined && r > bestRank) {
        bestRank = r;
        best = tag;
      }
    }
    if (best) byNode.set(node.id, best);
    else unassigned.push(node.id);
  }

  // Pull the untagged in along their strongest edge. Two passes, so a node
  // linked only to another untagged node still gets there; more than that
  // would let one topic bleed across the whole graph.
  const known = new Set(nodes.map((n) => n.id));
  for (let pass = 0; pass < 2; pass++) {
    const votes = new Map<string, Map<string, number>>();
    for (const e of edges) {
      if (!known.has(e.a) || !known.has(e.b)) continue;
      for (const [from, to] of [
        [e.a, e.b],
        [e.b, e.a],
      ]) {
        if (byNode.has(from)) continue;
        const cluster = byNode.get(to);
        if (!cluster) continue;
        const tally = votes.get(from) ?? new Map<string, number>();
        tally.set(cluster, (tally.get(cluster) ?? 0) + e.weight);
        votes.set(from, tally);
      }
    }
    if (votes.size === 0) break;
    for (const [id, tally] of votes) {
      const winner = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      if (winner) byNode.set(id, winner[0]);
    }
  }

  for (const id of unassigned) if (!byNode.has(id)) byNode.set(id, OTHER_CLUSTER);
  return byNode;
}

/**
 * Where each neighbourhood sits. A golden-angle spiral, biggest cluster first,
 * spaced by how much room each needs — the same seeding idea as the node layout
 * one level up, so the arrangement is even and, more importantly, identical on
 * every open.
 */
export function clusterCentres(
  keys: readonly string[],
  sizes: Map<string, number>,
): Map<string, { x: number; y: number }> {
  const centres = new Map<string, { x: number; y: number }>();
  let radius = 0;
  keys.forEach((key, i) => {
    const theta = i * GOLDEN_ANGLE;
    // Each ring steps out by enough to clear the cluster before it, so a big
    // neighbourhood never lands on top of a small one.
    radius += i === 0 ? 0 : GRAPH_CLUSTER_SPACING * Math.sqrt(sizes.get(key) ?? 1);
    centres.set(key, { x: radius * Math.cos(theta), y: radius * Math.sin(theta) });
  });
  return centres;
}

/** Everything the layout needs to place nodes in neighbourhoods. */
export function buildClusters(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): ClusterLayout {
  const byNode = assignClusters(nodes, edges, anchorTopics(nodes));

  const sizes = new Map<string, number>();
  for (const key of byNode.values()) sizes.set(key, (sizes.get(key) ?? 0) + 1);

  // Largest first, but "everything else" always last — it is a leftovers bin,
  // not a topic, and it should never sit at the centre of the map.
  const keys = [...sizes.keys()].sort((a, b) => {
    if (a === OTHER_CLUSTER) return 1;
    if (b === OTHER_CLUSTER) return -1;
    return (sizes.get(b) ?? 0) - (sizes.get(a) ?? 0) || a.localeCompare(b);
  });

  return { byNode, centres: clusterCentres(keys, sizes), keys, sizes };
}
