import { describe, expect, it } from 'vitest';
import { GRAPH_TOUCH_THROTTLE_MS, HIGHLIGHT_NODE_MIN_CHARS } from './constants';
import {
  ephemeralNodes,
  mergeNode,
  nodeFromProgress,
  nodesFromRecords,
  pruneNodes,
} from './graphNodes';
import type { Recording } from './recordings';
import type {
  Annotation,
  BookmarkLink,
  BrainDumpNote,
  GraphNode,
  GraphNodeKind,
  Paper,
  ReadingProgress,
  VideoProgress,
} from './types';

const NOW = 1_700_000_000_000;

function reading(over: Partial<ReadingProgress> = {}): ReadingProgress {
  return {
    url: 'https://example.com/piece',
    title: 'A Piece',
    source: 'Example Feed',
    maxPercent: 40,
    activeSeconds: 120,
    firstOpenedAt: NOW - 1000,
    updatedAt: NOW,
    completedAt: null,
    nudge: { count: 0, lastAt: 0, dismissed: false },
    feedItemId: null,
    scrollY: 0,
    pageHeight: 0,
    ...over,
  };
}

function watching(over: Partial<VideoProgress> = {}): VideoProgress {
  return {
    kind: 'video',
    url: 'https://www.youtube.com/watch?v=abc',
    title: 'A Talk',
    source: 'A Channel',
    maxPercent: 80,
    activeSeconds: 900,
    firstOpenedAt: NOW - 1000,
    updatedAt: NOW,
    completedAt: null,
    nudge: { count: 0, lastAt: 0, dismissed: false },
    videoId: 'abc',
    durationSeconds: 1200,
    positionSeconds: 960,
    ...over,
  };
}

function node(id: string, kind: GraphNodeKind, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind,
    title: id,
    url: '',
    source: '',
    tags: [],
    tagSource: 'auto',
    tagInputHash: '',
    completion: 0,
    firstSeenAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe('nodeFromProgress', () => {
  it('maps an article read', () => {
    expect(nodeFromProgress('example.com/piece', reading(), undefined, NOW)).toMatchObject({
      id: 'example.com/piece',
      kind: 'article',
      title: 'A Piece',
      source: 'Example Feed',
      completion: 0.4,
    });
  });

  it('maps a video watch and carries its id', () => {
    expect(nodeFromProgress('yt:abc', watching(), undefined, NOW)).toMatchObject({
      kind: 'video',
      videoId: 'abc',
      completion: 0.8,
    });
  });

  it('falls back to the cached feed item for a bare entry', () => {
    const bare = reading({ title: '', source: '', url: '' });
    const item = {
      id: 'f1',
      title: 'Feed Title',
      link: 'https://example.com/piece',
      normalizedLink: 'example.com/piece',
      pubDate: '',
      snippet: '',
      source: 'The Feed',
      categories: ['ai'],
    };

    expect(nodeFromProgress('example.com/piece', bare, item, NOW)).toMatchObject({
      title: 'Feed Title',
      url: 'https://example.com/piece',
      source: 'The Feed',
    });
  });

  it('starts every node unenriched', () => {
    const n = nodeFromProgress('example.com/piece', reading(), undefined, NOW);

    expect(n.tagSource).toBe('auto');
    expect(n.tags).toEqual([]);
  });

  // The feed item's categories exist only while it is in `cachedItems`, which
  // is pruned at 300 entries. Miss them here and the best topic signal in the
  // system is gone for good — there is nowhere to read it back from.
  it('captures the feed item categories as normalized tags', () => {
    const item = {
      id: 'f1',
      title: 'Feed Title',
      link: 'https://example.com/piece',
      normalizedLink: 'example.com/piece',
      pubDate: '',
      snippet: '',
      source: 'The Feed',
      categories: ['Machine Learning', 'machine learning', 'Neuroscience'],
    };

    const n = nodeFromProgress('example.com/piece', reading(), item, NOW);

    expect(n.tags).toEqual(['machine learning', 'neuroscience']);
    expect(n.tagSource).toBe('auto');
  });
});

describe('ephemeralNodes', () => {
  const note = (over: Partial<BrainDumpNote> = {}): BrainDumpNote => ({
    id: 'n1',
    rawText: 'Reading about diffusion models today, they keep coming up',
    status: 'raw',
    bullets: [],
    proposedTasks: [],
    createdAt: NOW,
    structuredAt: null,
    ...over,
  });

  const highlight = (over: Partial<Annotation> = {}): Annotation => ({
    id: 'a1',
    docKey: 'arxiv:1',
    docUrl: 'https://arxiv.org/abs/1',
    paperId: null,
    kind: 'highlight',
    anchor: { kind: 'text', blockIndex: 0, quote: 'q', prefix: '', suffix: '' },
    text: 'short',
    color: 'yellow',
    note: '',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });

  // The whole point of the passcode is that a sealed note is not readable. If
  // the graph draws one, the vault hides notes from the notes page while
  // publishing their first line two clicks away.
  it('emits no note nodes at all while the vault is locked', () => {
    const nodes = ephemeralNodes({ notes: [note()], annotations: [], locked: true });

    expect(nodes).toEqual([]);
  });

  it('emits a note node once unlocked, titled by its opening words', () => {
    const [n] = ephemeralNodes({ notes: [note()], annotations: [], locked: false });

    expect(n).toMatchObject({ id: 'note:n1', kind: 'note' });
    expect(n.title).toContain('diffusion models');
  });

  // Every yellow swipe becoming a node buries the graph in confetti.
  it('ignores a bare highlight with no note and nothing substantial in it', () => {
    const nodes = ephemeralNodes({ notes: [], annotations: [highlight()], locked: false });

    expect(nodes).toEqual([]);
  });

  it('keeps a highlight the user actually wrote on', () => {
    const annotated = highlight({ note: 'This is the key claim of the paper' });
    const [n] = ephemeralNodes({ notes: [], annotations: [annotated], locked: false });

    expect(n).toMatchObject({ id: 'hl:a1', kind: 'highlight' });
  });

  it('keeps a long quote even with no note attached', () => {
    const long = highlight({ text: 'x'.repeat(HIGHLIGHT_NODE_MIN_CHARS) });

    expect(ephemeralNodes({ notes: [], annotations: [long], locked: false })).toHaveLength(1);
  });

  // Highlights are not sealed, so they are shown either way — but this pins
  // the asymmetry so nobody "fixes" it into hiding both or neither.
  it('still shows highlights while the notes vault is locked', () => {
    const annotated = highlight({ note: 'A thought' });

    expect(ephemeralNodes({ notes: [], annotations: [annotated], locked: true })).toHaveLength(1);
  });
});

describe('nodesFromRecords', () => {
  const paper = (over: Partial<Paper> = {}): Paper => ({
    id: 'p1',
    deckId: 'd1',
    title: 'Attention',
    authors: 'A',
    venue: 'NeurIPS',
    year: 2017,
    citations: 1,
    url: 'https://arxiv.org/abs/1706.03762',
    abstract: '',
    relevance: '',
    status: 'reading',
    progressPercent: 50,
    leftOff: '',
    addedAt: NOW - 5000,
    updatedAt: NOW,
    lastReadAt: NOW,
    ...over,
  });

  const bookmark = (over: Partial<BookmarkLink> = {}): BookmarkLink => ({
    id: 'b1',
    url: 'https://blog.dev/x',
    title: 'X',
    groupId: 'g1',
    createdAt: NOW,
    ...over,
  });

  const rec = (over: Partial<Recording> = {}): Recording => ({
    id: 'r1',
    title: 'Lecture 3',
    source: { kind: 'youtube', videoId: 'abc' },
    startedAt: NOW,
    durationSeconds: 60,
    status: 'ready',
    segments: [],
    summary: '',
    actionItems: [],
    error: '',
    updatedAt: NOW,
    ...over,
  });

  const live = {
    papers: [paper()],
    bookmarks: [bookmark()],
    bookmarkGroups: [{ id: 'g1', name: 'Reading', createdAt: NOW }],
    decks: [{ id: 'd1', name: 'Transformers', createdAt: NOW, kind: 'papers' as const }],
    recordings: [rec()],
  };

  it('namespaces ids so kinds can never collide', () => {
    expect(nodesFromRecords(live).map((n) => n.id)).toEqual([
      'paper:p1',
      'bm:b1',
      'recording:r1',
    ]);
  });

  it('names a paper by its venue and a bookmark by its group', () => {
    const [p, b] = nodesFromRecords(live);

    expect(p.source).toBe('NeurIPS');
    expect(p.deckId).toBe('d1');
    expect(b.source).toBe('Reading');
  });

  it('falls back to the deck name when a paper has no venue', () => {
    const [p] = nodesFromRecords({ ...live, papers: [paper({ venue: '' })] });

    expect(p.source).toBe('Transformers');
  });

  it('carries a YouTube recording video id, so it can find its video', () => {
    expect(nodesFromRecords(live)[2].videoId).toBe('abc');
  });

  it('leaves a still-transcribing recording incomplete', () => {
    const [, , r] = nodesFromRecords({ ...live, recordings: [rec({ status: 'transcribing' })] });

    expect(r.completion).toBe(0);
  });
});

describe('mergeNode', () => {
  const incoming = node('a', 'article', { title: 'A', completion: 0.5 });

  it('creates a node when there is nothing stored', () => {
    expect(mergeNode(undefined, incoming, NOW)).toMatchObject({ id: 'a', completion: 0.5 });
  });

  // Without this the 5s tracker heartbeat rewrites the whole collection 720
  // times an hour for a node whose only change is a timestamp.
  it('declines the write inside the throttle window', () => {
    const stored = node('a', 'article', { title: 'A', completion: 0.5, updatedAt: NOW - 1000 });

    expect(mergeNode(stored, incoming, NOW)).toBe(null);
  });

  it('writes once the throttle window has passed', () => {
    const stored = node('a', 'article', {
      title: 'A',
      completion: 0.5,
      updatedAt: NOW - GRAPH_TOUCH_THROTTLE_MS - 1,
    });

    expect(mergeNode(stored, incoming, NOW)).not.toBe(null);
  });

  it('writes immediately when something is finished', () => {
    const stored = node('a', 'article', { title: 'A', completion: 0.8, updatedAt: NOW - 1000 });
    const done = node('a', 'article', { title: 'A', completion: 1 });

    expect(mergeNode(stored, done, NOW)).toMatchObject({ completion: 1 });
  });

  it('writes immediately when the title changes', () => {
    const stored = node('a', 'article', { title: 'Old', completion: 0.5, updatedAt: NOW - 1000 });

    expect(mergeNode(stored, incoming, NOW)).toMatchObject({ title: 'A' });
  });

  it('preserves tags, enrichment state and first-seen across a merge', () => {
    const stored = node('a', 'article', {
      title: 'Old',
      tags: ['transformers'],
      tagSource: 'ai',
      tagInputHash: 'h1',
      firstSeenAt: NOW - 99_000,
    });

    expect(mergeNode(stored, incoming, NOW)).toMatchObject({
      tags: ['transformers'],
      tagSource: 'ai',
      tagInputHash: 'h1',
      firstSeenAt: NOW - 99_000,
    });
  });

  it('never lets completion go backwards', () => {
    const stored = node('a', 'article', { title: 'Old', completion: 0.9 });

    expect(mergeNode(stored, incoming, NOW)?.completion).toBe(0.9);
  });

  // A node tracked before its feed item was cached has no tags, and nothing
  // later reconsiders it — `needsTags` only looks at the text. Without the
  // backfill it stays unlabelled for as long as it exists.
  it('backfills seed tags onto a node that has none', () => {
    const stored = node('a', 'article', { title: 'A', updatedAt: NOW - 1000 });
    const seeded = node('a', 'article', { title: 'A', tags: ['neuroscience'] });

    expect(mergeNode(stored, seeded, NOW)).toMatchObject({
      tags: ['neuroscience'],
      tagSource: 'auto',
    });
  });

  // The tracker calls this on a 5-second heartbeat with a freshly projected
  // node that never carries tags. Get the guard wrong and every heartbeat
  // wipes labels the user paid a model to produce.
  it('never lets a fresh projection clobber AI tags', () => {
    const stored = node('a', 'article', {
      title: 'A',
      tags: ['diffusion models'],
      tagSource: 'ai',
      tagInputHash: 'h1',
      updatedAt: NOW - GRAPH_TOUCH_THROTTLE_MS - 1,
    });
    const bare = node('a', 'article', { title: 'A', tags: [] });

    expect(mergeNode(stored, bare, NOW)).toMatchObject({
      tags: ['diffusion models'],
      tagSource: 'ai',
      tagInputHash: 'h1',
    });
  });

  // The backfill is computed inside the merge, so if the throttle's "worth a
  // write" check does not count it, the seeds are built and then dropped on
  // every heartbeat but the first of each five-minute window.
  it('treats a backfill as worth writing even inside the throttle window', () => {
    const stored = node('a', 'article', { title: 'A', updatedAt: NOW - 1000 });
    const seeded = node('a', 'article', { title: 'A', tags: ['neuroscience'] });

    expect(mergeNode(stored, seeded, NOW)).not.toBe(null);
  });
});

describe('pruneNodes', () => {
  it('leaves a collection under the cap alone', () => {
    const nodes = [node('a', 'article'), node('p', 'paper')];

    expect(pruneNodes(nodes, 10)).toEqual(nodes);
  });

  it('evicts the oldest articles and videos first', () => {
    const nodes = [
      node('old', 'article', { updatedAt: NOW - 5000 }),
      node('new', 'article', { updatedAt: NOW }),
      node('mid', 'video', { updatedAt: NOW - 1000 }),
    ];

    expect(pruneNodes(nodes, 2).map((n) => n.id)).toEqual(['new', 'mid']);
  });

  // A record-backed node is governed by its own collection; evicting one here
  // would just resurrect it on the next reconcile.
  it('never evicts a node that mirrors a durable record', () => {
    const nodes = [
      node('p1', 'paper'),
      node('p2', 'paper'),
      node('b1', 'bookmark'),
      node('r1', 'recording'),
      node('a1', 'article', { updatedAt: NOW }),
    ];

    expect(pruneNodes(nodes, 2).map((n) => n.id)).toEqual(['p1', 'p2', 'b1', 'r1']);
  });
});
