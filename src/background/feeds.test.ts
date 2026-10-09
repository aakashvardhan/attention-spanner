import { describe, expect, it, vi } from 'vitest';
import { appendRead, applyMarkAllRead, mergeFeedItems, openArticle } from './feeds';
import type { FeedItem } from '../shared/types';

/** `n` orders both the id and the pubDate, so "newest" is unambiguous in assertions */
function item(n: number, over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: `i${n}`,
    title: `Item ${n}`,
    link: `https://example.com/${n}`,
    normalizedLink: `https://example.com/${n}`,
    pubDate: new Date(Date.UTC(2026, 0, n)).toISOString(),
    snippet: '',
    source: 'Example',
    categories: [],
    ...over,
  };
}

const ids = (items: FeedItem[]) => items.map((i) => i.id);

describe('mergeFeedItems', () => {
  it('keeps existing items the incoming fetch no longer carries', () => {
    // An article that scrolls out of a feed's window must not vanish unread
    const merged = mergeFeedItems([item(1), item(2)], [item(3)], 50);
    expect(ids(merged)).toEqual(['i3', 'i2', 'i1']);
  });

  it('dedupes by id, letting the incoming copy win', () => {
    const merged = mergeFeedItems([item(1, { title: 'Old' })], [item(1, { title: 'New' })], 50);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('New');
  });

  it('dedupes items two feeds both carry', () => {
    const shared = item(1, { source: 'Aggregator' });
    const merged = mergeFeedItems([], [item(1), shared], 50);
    expect(merged).toHaveLength(1);
  });

  it('returns newest first', () => {
    const merged = mergeFeedItems([item(2)], [item(5), item(1)], 50);
    expect(ids(merged)).toEqual(['i5', 'i2', 'i1']);
  });

  it('caps the cache, dropping the oldest', () => {
    const merged = mergeFeedItems([item(1), item(2)], [item(3), item(4)], 3);
    expect(ids(merged)).toEqual(['i4', 'i3', 'i2']);
  });
});

describe('applyMarkAllRead', () => {
  it('marks everything currently cached', () => {
    expect(applyMarkAllRead([], [item(2), item(1)], 50).sort()).toEqual(['i1', 'i2']);
  });

  it('keeps prior history for items that left the cache', () => {
    const next = applyMarkAllRead(['gone'], [item(1)], 50);
    expect(next).toContain('gone');
    expect(next).toContain('i1');
  });

  it('does not duplicate ids already marked read', () => {
    expect(applyMarkAllRead(['i1'], [item(1)], 50)).toEqual(['i1']);
  });

  it('caps by dropping the oldest ids, keeping the newest', () => {
    // cachedItems arrives newest-first; the cap must not discard the newest ids
    const next = applyMarkAllRead([], [item(3), item(2), item(1)], 2);
    expect(next).toHaveLength(2);
    expect(next).toContain('i3');
    expect(next).not.toContain('i1');
  });
});

describe('openArticle', () => {
  it('sends an arXiv PDF to alphaXiv, not the reader', async () => {
    // A resume nudge for a paper left in the reader lands here with the PDF URL
    const create = vi.fn(async () => ({}));
    vi.stubGlobal('chrome', { tabs: { create } });
    await openArticle('https://arxiv.org/pdf/2406.09246', null, true);
    expect(create).toHaveBeenCalledWith({ url: 'https://www.alphaxiv.org/abs/2406.09246' });
    vi.unstubAllGlobals();
  });
});

describe('appendRead', () => {
  it('appends new ids once, in order, and evicts the oldest past the cap', () => {
    expect(appendRead(['a', 'b'], ['b', 'c', 'd', 'c'], 3)).toEqual(['b', 'c', 'd']);
    expect(appendRead([], [], 3)).toEqual([]);
  });
});
