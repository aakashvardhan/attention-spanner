import { normalizeTag } from './ai/topics';
import {
  GRAPH_TAGS_PER_NODE,
  GRAPH_TOUCH_THROTTLE_MS,
  HIGHLIGHT_NODE_MIN_CHARS,
  MAX_GRAPH_NODES,
} from './constants';
import { recordingDocUrl, type Recording } from './recordings';
import type {
  Annotation,
  AnyProgress,
  BookmarkGroup,
  BrainDumpNote,
  BookmarkLink,
  Deck,
  FeedItem,
  GraphNode,
  Paper,
} from './types';

/**
 * Building graph vertices out of the records that imply them. Pure — the
 * chrome-touching wrappers live in background/graphNodes.ts, and the v14
 * migration reuses `nodeFromProgress` from the service worker.
 */

/** How much of a note's opening becomes its title in the graph. */
const NOTE_TITLE_CHARS = 60;

/** Node kinds that stand on their own account, and so can be evicted by the cap. */
const EVICTABLE = new Set(['article', 'video']);

/** A recording carries no progress of its own — it is done or it is not. */
function recordingCompletion(status: Recording['status']): number {
  return status === 'ready' ? 1 : 0;
}

/**
 * Deterministic topic labels from words the user's own data already produced —
 * a feed's categories, a deck or group name, a venue. These are what stop the
 * first labelling batch from working off a blank vocabulary, and they cost
 * nothing: no model, no network, no guess.
 */
function seedTags(...raw: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of raw) {
    if (!value) continue;
    const tag = normalizeTag(value);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length === GRAPH_TAGS_PER_NODE) break;
  }
  return out;
}

/**
 * The vertex an article or video progress entry implies. `item` is the cached
 * feed item behind an article, when there still is one — its categories are
 * the best topic signal in the system and vanish with `cachedItems`, so this
 * is the only moment they can be captured.
 */
export function nodeFromProgress(
  key: string,
  p: AnyProgress,
  item: FeedItem | undefined,
  now: number,
): GraphNode {
  const video = p.kind === 'video';
  return {
    id: key,
    kind: video ? 'video' : 'article',
    title: p.title || item?.title || p.url,
    url: p.url || item?.link || '',
    source: p.source || item?.source || '',
    ...(video ? { videoId: p.videoId } : {}),
    // The feed item's own categories. This is the only moment they exist —
    // `cachedItems` is pruned at 300 entries and they are unrecoverable after.
    tags: seedTags(...(item?.categories ?? [])),
    tagSource: 'auto',
    tagInputHash: '',
    completion: Math.max(0, Math.min(1, p.maxPercent / 100)),
    firstSeenAt: p.firstOpenedAt || now,
    updatedAt: p.updatedAt || now,
  };
}

export interface RecordCollections {
  papers: Paper[];
  bookmarks: BookmarkLink[];
  bookmarkGroups: BookmarkGroup[];
  decks: Deck[];
  recordings: Recording[];
}

/**
 * The vertices the durable collections imply. Recomputed on every graph open
 * rather than hooked at each write site: these records are id-addressable, so
 * one pass covers creation, edits and deletion alike.
 */
export function nodesFromRecords(live: RecordCollections): GraphNode[] {
  const deckName = new Map(live.decks.map((d) => [d.id, d.name]));
  const groupName = new Map(live.bookmarkGroups.map((g) => [g.id, g.name]));
  const nodes: GraphNode[] = [];

  for (const p of live.papers) {
    nodes.push({
      id: `paper:${p.id}`,
      kind: 'paper',
      title: p.title,
      url: p.url,
      source: p.venue || deckName.get(p.deckId) || '',
      deckId: p.deckId,
      tags: seedTags(p.venue, deckName.get(p.deckId)),
      tagSource: 'auto',
      tagInputHash: '',
      completion: Math.max(0, Math.min(1, p.progressPercent / 100)),
      firstSeenAt: p.addedAt,
      updatedAt: p.lastReadAt ?? p.updatedAt,
    });
  }

  for (const b of live.bookmarks) {
    nodes.push({
      id: `bm:${b.id}`,
      kind: 'bookmark',
      title: b.title,
      url: b.url,
      source: (b.groupId && groupName.get(b.groupId)) || '',
      groupId: b.groupId,
      tags: seedTags(b.groupId ? groupName.get(b.groupId) : undefined),
      tagSource: 'auto',
      tagInputHash: '',
      completion: 0,
      firstSeenAt: b.createdAt,
      updatedAt: b.updatedAt ?? b.createdAt,
    });
  }

  for (const r of live.recordings) {
    nodes.push({
      id: recordingDocUrl(r.id),
      kind: 'recording',
      title: r.title,
      url: recordingDocUrl(r.id),
      source: r.purpose ?? '',
      ...(r.source.kind === 'youtube' ? { videoId: r.source.videoId } : {}),
      tags: [],
      tagSource: 'auto',
      tagInputHash: '',
      completion: recordingCompletion(r.status),
      firstSeenAt: r.startedAt,
      updatedAt: r.updatedAt,
    });
  }

  return nodes;
}

export interface WritingCollections {
  /** Already decrypted by the caller; empty while the vault is locked */
  notes: BrainDumpNote[];
  annotations: Annotation[];
  /** notesVault !== null && no session key — see notesLock.ts */
  locked: boolean;
}

/**
 * The vertices the user's own writing implies: brain dumps, and highlights
 * substantial enough to be about something.
 *
 * **These are projected on every graph open and never written to storage.**
 * Three reasons, and the third decides it:
 *
 *  1. They mirror id-addressable records, so storing them buys nothing — the
 *     same argument that already makes `nodesFromRecords` a recompute.
 *  2. `annotations` is deliberately outside RECORD_COLLECTIONS, and a stored
 *     node would smuggle highlight text into a collection that syncs.
 *  3. A brain dump can be sealed. `graphNodes` is plaintext local storage, so
 *     persisting a note's first line there would defeat the passcode entirely:
 *     the vault would hide notes from the notes page while the graph published
 *     them. Projection removes the possibility instead of relying on a rule
 *     every future writer has to remember.
 *
 * A locked vault therefore yields no note nodes at all — which is the honest
 * outcome, because without the passcode there is genuinely nothing to show.
 */
export function ephemeralNodes(live: WritingCollections): GraphNode[] {
  const nodes: GraphNode[] = [];

  if (!live.locked) {
    for (const note of live.notes) {
      const text = [note.rawText, ...note.bullets].join(' ').trim();
      if (!text) continue;
      nodes.push({
        id: `note:${note.id}`,
        kind: 'note',
        title: noteTitle(text),
        url: '',
        source: new Date(note.createdAt).toLocaleDateString(),
        tags: [],
        tagSource: 'auto',
        tagInputHash: '',
        completion: 0,
        firstSeenAt: note.createdAt,
        updatedAt: note.structuredAt ?? note.createdAt,
      });
    }
  }

  for (const a of live.annotations) {
    // A bare yellow swipe is not a thought. Requiring a note or a substantial
    // quote is what keeps the graph from filling with confetti.
    if (!a.note && a.text.length < HIGHLIGHT_NODE_MIN_CHARS) continue;
    nodes.push({
      id: `hl:${a.id}`,
      kind: 'highlight',
      title: noteTitle(a.note || a.text),
      url: a.docUrl,
      source: 'highlight',
      tags: [],
      tagSource: 'auto',
      tagInputHash: '',
      completion: 0,
      firstSeenAt: a.createdAt,
      updatedAt: a.updatedAt,
    });
  }

  return nodes;
}

/** First line, trimmed — a note has no title, so its opening words are one. */
function noteTitle(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? text;
  const clean = line.replace(/\s+/g, ' ').trim();
  return clean.length > NOTE_TITLE_CHARS ? `${clean.slice(0, NOTE_TITLE_CHARS).trimEnd()}…` : clean;
}

/**
 * Fold an incoming node over what is already stored, returning null when
 * nothing worth a write changed. The throttle lives here rather than at the
 * call sites because this is the only place that has both timestamps: a
 * 5-second tracker heartbeat would otherwise rewrite the whole collection 720
 * times an hour.
 *
 * Tags survive the merge — they are the expensive part. But an *empty* set is
 * not worth keeping: a node created before its feed item was cached would
 * otherwise stay untagged forever, since nothing later reconsiders it. So the
 * incoming seeds backfill an unlabelled node, and AI labels are never touched.
 */
export function mergeNode(
  existing: GraphNode | undefined,
  incoming: GraphNode,
  now: number,
): GraphNode | null {
  if (!existing) return { ...incoming, firstSeenAt: incoming.firstSeenAt || now };

  const keepTags = existing.tagSource === 'ai' || existing.tagSource === 'manual' || existing.tags.length > 0;
  const merged: GraphNode = {
    ...incoming,
    tags: keepTags ? existing.tags : incoming.tags,
    tagSource: keepTags ? existing.tagSource : incoming.tagSource,
    tagInputHash: keepTags ? existing.tagInputHash : incoming.tagInputHash,
    firstSeenAt: existing.firstSeenAt,
    completion: Math.max(existing.completion, incoming.completion),
    updatedAt: now,
  };

  // Finishing something is always worth recording immediately; the completion
  // ring is the one part of the node a user would notice going stale.
  const finishedNow = existing.completion < 0.9 && merged.completion >= 0.9;
  const stale = now - existing.updatedAt > GRAPH_TOUCH_THROTTLE_MS;
  // Tags count as a change, or the backfill above would be computed and then
  // thrown away by the throttle on every heartbeat but the first of a window.
  const changed =
    existing.title !== merged.title ||
    existing.url !== merged.url ||
    existing.source !== merged.source ||
    existing.tags.length !== merged.tags.length;
  if (!finishedNow && !stale && !changed) return null;
  return merged;
}

/**
 * Newest-wins cap. Only article and video nodes are evictable: every other
 * kind mirrors a record whose own collection already governs its lifetime, so
 * dropping one here would just resurrect it on the next reconcile.
 */
export function pruneNodes(nodes: GraphNode[], cap = MAX_GRAPH_NODES): GraphNode[] {
  if (nodes.length <= cap) return nodes;
  const kept = nodes.filter((n) => !EVICTABLE.has(n.kind));
  const evictable = nodes
    .filter((n) => EVICTABLE.has(n.kind))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(0, cap - kept.length));
  const keep = new Set([...kept, ...evictable].map((n) => n.id));
  return nodes.filter((n) => keep.has(n.id));
}
