import { describe, expect, it } from 'vitest';
import type { AnyProgress, FeedItem, Paper } from '../types';
import { interestProfile, rankItems, unreadItems, type ProfileEntry } from './triage';

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
      { item: items[0], because: null },
      { item: items[1], because: null },
    ]);
  });
});
