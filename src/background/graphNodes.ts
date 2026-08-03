import type { TagAssignment } from '../shared/ai/topics';
import {
  mergeNode,
  nodeFromProgress,
  nodesFromRecords,
  pruneNodes,
} from '../shared/graphNodes';
import { getLocal, setLocal } from '../shared/storage';
import type { AnyProgress, GraphNode } from '../shared/types';

/**
 * Keeping the knowledge graph's vertices up to date. The rules live in
 * shared/graphNodes.ts; this file is the thin chrome-touching layer, so that
 * every write still goes through the service worker.
 */

/**
 * Record an article or video read. Called from the tracking handlers on every
 * heartbeat — `mergeNode` decides whether that is worth a write, so the common
 * case costs one storage read and nothing else.
 */
export async function touchProgressNode(key: string, progress: AnyProgress): Promise<void> {
  const { graphNodes, cachedItems } = await getLocal('graphNodes', 'cachedItems');
  const now = Date.now();
  const item = progress.kind === 'video' ? undefined : cachedItems.find((c) => c.normalizedLink === key);

  const existing = graphNodes.find((n) => n.id === key);
  const merged = mergeNode(existing, nodeFromProgress(key, progress, item, now), now);
  if (!merged) return;

  const next = existing
    ? graphNodes.map((n) => (n.id === key ? merged : n))
    : [...graphNodes, merged];
  await setLocal({ graphNodes: pruneNodes(next) });
}

/**
 * Rebuild the vertices that mirror durable records, then drop any that no
 * longer have one. Runs when the graph page opens rather than on every write:
 * papers, bookmarks and recordings are id-addressable, so a single pass covers
 * creation, edits and deletion, and it also catches records that arrived via
 * cloud sync rather than through a handler here.
 */
export async function reconcileGraphNodes(): Promise<void> {
  const { graphNodes, papers, bookmarks, bookmarkGroups, decks, recordings } = await getLocal(
    'graphNodes',
    'papers',
    'bookmarks',
    'bookmarkGroups',
    'decks',
    'recordings',
  );
  const now = Date.now();

  const stored = new Map(graphNodes.map((n) => [n.id, n]));
  const fresh = nodesFromRecords({ papers, bookmarks, bookmarkGroups, decks, recordings });

  // Articles and videos are kept as-is — they are nobody's mirror. Every other
  // node is replaced by what the records say now, so a deleted paper's node
  // simply never gets rebuilt.
  const next: GraphNode[] = [
    ...graphNodes.filter((n) => n.kind === 'article' || n.kind === 'video'),
    ...fresh.map((n) => mergeNode(stored.get(n.id), n, now) ?? stored.get(n.id) ?? n),
  ];

  await setLocal({ graphNodes: pruneNodes(next) });
}

/**
 * Write a batch of topic labels. Assignments for nodes that have since gone
 * are dropped rather than resurrecting them: a labelling run takes tens of
 * seconds, and a paper can be deleted in another tab while it is in flight.
 */
export async function applyTags(
  assignments: TagAssignment[],
): Promise<{ ok: boolean; updated: number }> {
  const { graphNodes } = await getLocal('graphNodes');
  const byId = new Map(assignments.map((a) => [a.id, a]));
  let updated = 0;

  const next = graphNodes.map((node) => {
    const assignment = byId.get(node.id);
    if (!assignment) return node;
    updated += 1;
    return {
      ...node,
      tags: assignment.tags,
      tagSource: 'ai' as const,
      tagInputHash: assignment.tagInputHash,
    };
  });

  if (updated > 0) await setLocal({ graphNodes: next });
  return { ok: true, updated };
}

/** User edits win over both seed metadata and AI enrichment. */
export async function setManualTags(id: string, tags: string[]): Promise<{ ok: boolean; updated: number }> {
  const { graphNodes } = await getLocal('graphNodes');
  const unique = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 3);
  let updated = 0;
  const next = graphNodes.map((node) => {
    if (node.id !== id) return node;
    updated += 1;
    return { ...node, tags: unique, tagSource: 'manual' as const, tagInputHash: '' };
  });
  if (updated) await setLocal({ graphNodes: next });
  return { ok: true, updated };
}
