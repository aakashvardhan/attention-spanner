import { describe, expect, it } from 'vitest';
import type { AnyProgress, FeedItem, Paper } from '../types';
import {
  alsoLabel,
  byRelevance,
  clusterPicks,
  interestProfile,
  muteMatcher,
  normalizeTopics,
  rankItems,
  unreadItems,
  type Pick,
  type ProfileEntry,
} from './triage';

const item = (id: string, title: string): FeedItem => ({
  id,
  title,
  link: `https://example.com/${id}`,
  normalizedLink: `example.com/${id}`,
  pubDate: '',
  snippet: '',
  source: 'Feed',
});

describe('interestProfile', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const day = 24 * 60 * 60_000;

  it('learns from papers in progress or read, and articles finished this month', () => {
    const papers = [
      { id: 'a', title: 'Attention', abstract: 'Transformers.', status: 'reading', addedAt: 1, lastReadAt: 5 },
      { id: 'b', title: 'Unread paper', abstract: '', status: 'to-read', addedAt: 1, lastReadAt: null },
    ] as Paper[];
    const progress = {
      fresh: { url: 'u1', title: 'Finished recently', completedAt: now - day, kind: 'article' },
      old: { url: 'u2', title: 'Finished long ago', completedAt: now - 60 * day, kind: 'article' },
      open: { url: 'u3', title: 'Half read', completedAt: null, kind: 'article' },
      video: { url: 'u4', title: 'A video', completedAt: now - day, kind: 'video' },
    } as unknown as Record<string, AnyProgress>;
    expect(interestProfile(papers, progress, now).map((e) => e.label)).toEqual([
      'Attention',
      'Finished recently',
    ]);
  });
});

describe('unreadItems', () => {
  it('drops read items and keeps feed order', () => {
    const items = [item('1', 'a'), item('2', 'b'), item('3', 'c')];
    expect(unreadItems(items, ['2'], 10).map((i) => i.id)).toEqual(['1', '3']);
    expect(unreadItems(items, [], 2)).toHaveLength(2);
  });
});

describe('rankItems', () => {
  const profile: ProfileEntry[] = [
    { id: 'p1', label: 'Graph neural networks', text: '' },
    { id: 'p2', label: 'Sourdough baking', text: '' },
  ];
  const vectors: Record<string, number[]> = {
    p1: [1, 0, 0],
    p2: [0, 1, 0],
    gnn: [0.95, 0.05, 0],
    bread: [0.1, 0.9, 0],
    cars: [0, 0, 1],
  };
  const items = [item('cars', 'Cars'), item('bread', 'Bread'), item('gnn', 'GNNs')];

  it('ranks by the closest thing you read, and says which it was', () => {
    const picks = rankItems(items, (i) => vectors[i.id], profile, (e) => vectors[e.id], 2);
    expect(picks.map((p) => [p.item.id, p.because])).toEqual([
      ['gnn', 'Graph neural networks'],
      ['bread', 'Sourdough baking'],
    ]);
  });

  it('claims no reason for an item that is merely the least unrelated', () => {
    const picks = rankItems(items, (i) => vectors[i.id], profile, (e) => vectors[e.id], 3);
    expect(picks.map((p) => [p.item.id, p.because])).toEqual([
      ['gnn', 'Graph neural networks'],
      ['bread', 'Sourdough baking'],
      ['cars', null],
    ]);
  });

  it('leaves out an item with no vector rather than scoring it zero', () => {
    const picks = rankItems(items, (i) => (i.id === 'gnn' ? undefined : vectors[i.id]), profile, (e) => vectors[e.id], 3);
    expect(picks.map((p) => p.item.id)).toEqual(['bread', 'cars']);
  });

  it('falls back to feed order, with no reason claimed, when there is no profile', () => {
    const picks = rankItems(items, (i) => vectors[i.id], [], () => undefined, 2);
    expect(picks).toEqual([
      { item: items[0], because: null, also: [] },
      { item: items[1], because: null, also: [] },
    ]);
  });
});

describe('byRelevance', () => {
  const picks = ['a', 'b', 'c'].map((id) => ({ item: item(id, id), because: null, also: [] }));

  it('puts the item Laya finds most relevant first and keeps k', () => {
    const answers = { 0: { type: 'noul' as const, noul: 0.04 }, 1: { type: 'noul' as const, noul: 0.3 }, 2: { type: 'noul' as const, noul: 0.12 } };
    expect(byRelevance(picks, answers, 2).map((p) => p.item.id)).toEqual(['b', 'c']);
  });

  it('keeps the embedding order where Laya gave no answer', () => {
    expect(byRelevance(picks, {}, 3).map((p) => p.item.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('normalizeTopics', () => {
  it('trims, collapses spaces, drops blanks and case-insensitive duplicates, keeps order', () => {
    expect(normalizeTopics(['  Sports ', '', 'sports', 'US   election', 'Election'])).toEqual(['Sports', 'US election', 'Election']);
  });

  it('reads a stored string as lines and anything else as empty', () => {
    expect(normalizeTopics('politics\n\ncrypto')).toEqual(['politics', 'crypto']);
    expect(normalizeTopics(undefined)).toEqual([]);
    expect(normalizeTopics(42)).toEqual([]);
    expect(normalizeTopics([1, null, 'ok'])).toEqual(['ok']);
  });

  it('caps the count and the length of each topic', () => {
    expect(normalizeTopics(Array.from({ length: 150 }, (_, i) => `t${i}`))).toHaveLength(100);
    expect(normalizeTopics(['x'.repeat(200)])[0]).toHaveLength(80);
  });
});

describe('muteMatcher', () => {
  const muted = (topics: unknown, title: string, extra: Partial<FeedItem> = {}) => muteMatcher(topics)({ ...item('1', title), ...extra });

  it('matches whole words in any case, in title, snippet or source', () => {
    expect(muted(['election'], 'The Election results')).toBe(true);
    expect(muted(['election'], 'Elections are coming')).toBe(false);
    expect(muted(['ai'], 'He said hello')).toBe(false);
    expect(muted(['ai'], 'An AI model')).toBe(true);
    expect(muted(['sports'], 'Quiet', { snippet: 'Sports roundup' })).toBe(true);
    expect(muted(['The Verge'], 'Anything', { source: 'The Verge' })).toBe(true);
  });

  it('treats regex characters literally and handles non-English letters', () => {
    expect(muted(['C++'], 'Modern C++ tips')).toBe(true);
    expect(muted(['C++'], 'C is fine')).toBe(false);
    expect(muted(['a.b'], 'axb')).toBe(false);
    expect(muted(['(draft)'], 'Paper (draft) notes')).toBe(true);
    expect(muted(['Économie'], "L'économie française")).toBe(true);
    expect(muted(['café'], 'cafés')).toBe(false);
  });

  it('matches a multi-word topic across any whitespace', () => {
    expect(muted(['US election'], 'US\n election night')).toBe(true);
  });

  it('mutes nothing when there are no topics or the stored value is corrupt', () => {
    expect(muted([], 'Anything')).toBe(false);
    expect(muted('', 'Anything')).toBe(false);
    expect(muted({ bad: true }, 'Anything')).toBe(false);
  });

  it('checks 300 items against 100 topics in well under 50 ms', () => {
    const topics = Array.from({ length: 100 }, (_, i) => `topic${i}`);
    const items = Array.from({ length: 300 }, (_, i) => item(String(i), `Headline number ${i} about things`));
    const isMuted = muteMatcher(topics);
    const start = performance.now();
    items.filter(isMuted);
    // ponytail: wall-clock budget with headroom for slow CI runners.
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe('clusterPicks', () => {
  const pick = (id: string, source = 'Feed'): Pick => ({ item: { ...item(id, `t${id}`), source }, because: null, also: [] });
  const vectors: Record<string, number[]> = { a: [1, 0, 0], b: [0.99, 0.05, 0], c: [0, 1, 0], d: [0.98, 0.1, 0] };
  const vectorOf = (i: FeedItem) => vectors[i.id];

  it('folds near-duplicates into the first, highest-ranked pick, keeping rank order', () => {
    const out = clusterPicks([pick('a'), pick('c'), pick('b'), pick('d')], vectorOf);
    expect(out.map((p) => [p.item.id, p.also.map((x) => x.id)])).toEqual([
      ['a', ['b', 'd']],
      ['c', []],
    ]);
  });

  it('leaves picks without a vector alone and respects the threshold', () => {
    expect(clusterPicks([pick('a'), pick('x'), pick('b')], vectorOf).map((p) => p.item.id)).toEqual(['a', 'x']);
    expect(clusterPicks([pick('a'), pick('b')], vectorOf, 0.9999).map((p) => p.item.id)).toEqual(['a', 'b']);
  });

  it('is empty for no picks', () => {
    expect(clusterPicks([], vectorOf)).toEqual([]);
  });
});

describe('alsoLabel', () => {
  const withAlso = (sources: string[]): Pick => ({
    item: { ...item('lead', 'Lead'), source: 'Ars' },
    because: null,
    also: sources.map((s, i) => ({ ...item(`x${i}`, 'x'), source: s })),
  });

  it('counts other sources, and says "similar" when the copies share the lead source', () => {
    expect(alsoLabel(withAlso([]))).toBe('');
    expect(alsoLabel(withAlso(['Verge']))).toBe('+1 source');
    expect(alsoLabel(withAlso(['Verge', 'Wired', 'Verge']))).toBe('+2 sources');
    expect(alsoLabel(withAlso(['Ars', 'Ars']))).toBe('+2 similar');
  });
});
