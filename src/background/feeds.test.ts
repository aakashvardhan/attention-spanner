import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendRead, applyMarkAllRead, mergeFeedItems, openArticle } from './feeds';
import { readerPagePath } from '../shared/pdf';
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
  it('sends an arXiv PDF to the reader, not alphaXiv', async () => {
    // A resume nudge for a paper left in the reader lands here with the PDF URL
    const create = vi.fn(async () => ({}));
    vi.stubGlobal('chrome', { tabs: { create }, runtime: { getURL: (path: string) => `chrome-extension://id/${path}` } });
    await openArticle('https://arxiv.org/pdf/2406.09246', null, true);
    expect(create).toHaveBeenCalledWith({
      url: `chrome-extension://id/${readerPagePath('https://arxiv.org/pdf/2406.09246')}`,
    });
    vi.unstubAllGlobals();
  });
});

describe('openArticle in the same tab', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the destination instead of creating a tab, and registers the tab it came from', async () => {
    const create = vi.fn(async () => ({}));
    const sessionSet = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', {
      tabs: { create, query: vi.fn(async () => []) },
      runtime: { getURL: (path: string) => `chrome-extension://id/${path}` },
      storage: { local: { get: vi.fn(async () => ({ readItems: [] })), set: vi.fn(async () => undefined) }, session: { get: vi.fn(async () => ({})), set: sessionSet } },
    });
    const res = await openArticle('https://arxiv.org/pdf/2406.09246', null, false, true, false, [], 7);
    expect(create).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, url: `chrome-extension://id/${readerPagePath('https://arxiv.org/pdf/2406.09246')}` });
  });

  it('returns no url when an existing video tab is focused', async () => {
    // focusExistingVideoTab finds the tab: tabs.query returns it.
    vi.stubGlobal('chrome', {
      tabs: { create: vi.fn(), query: vi.fn(async () => [{ id: 3, windowId: 1, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }]), update: vi.fn(async () => ({})) },
      windows: { update: vi.fn(async () => ({})) },
      storage: { local: { get: vi.fn(async () => ({ readItems: [] })), set: vi.fn() }, session: { get: vi.fn(async () => ({})), set: vi.fn() } },
    });
    const res = await openArticle('https://www.youtube.com/watch?v=dQw4w9WgXcQ', null, false, true, false, [], 7);
    expect(res).toEqual({ ok: true });
  });
});

describe('appendRead', () => {
  it('appends new ids once, in order, and evicts the oldest past the cap', () => {
    expect(appendRead(['a', 'b'], ['b', 'c', 'd', 'c'], 3)).toEqual(['b', 'c', 'd']);
    expect(appendRead([], [], 3)).toEqual([]);
  });
});
