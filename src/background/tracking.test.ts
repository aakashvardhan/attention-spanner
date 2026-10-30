import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleProgressUpdate, isKnownUrl } from './tracking';
import type { FeedItem } from '../shared/types';

const empty = { readingProgress: {}, cachedItems: [] as FeedItem[] };

describe('isKnownUrl', () => {
  it('recognizes a feed item', () => {
    const item = { normalizedLink: 'example.com/post' } as FeedItem;
    expect(isKnownUrl('example.com/post', { ...empty, cachedItems: [item] })).toBe(true);
  });

  it('recognizes a page that already has reading progress', () => {
    expect(
      isKnownUrl('example.com/old', {
        ...empty,
        readingProgress: { 'example.com/old': { maxPercent: 10 } as never },
      }),
    ).toBe(true);
  });

  it('ignores an unrelated page', () => {
    const item = { normalizedLink: 'example.com/post' } as FeedItem;
    expect(isKnownUrl('random.example/thing', { ...empty, cachedItems: [item] })).toBe(false);
  });
});

describe('handleProgressUpdate', () => {
  const store: Record<string, unknown> = {};
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    Object.assign(store, { readingProgress: {}, cachedItems: [], trackedTabs: {} });
    const get = (keys: string | string[]) =>
      Promise.resolve(Object.fromEntries([keys].flat().map((k) => [k, structuredClone(store[k])])));
    const set = (o: Record<string, unknown>) => Promise.resolve(void Object.assign(store, o));
    vi.stubGlobal('chrome', { storage: { local: { get, set }, session: { get, set } } });
  });

  it.each(['chrome-extension://abc/src/pages/newtab/index.html', 'chrome://newtab/'])(
    'ignores an extension page: %s',
    async (url) => {
      await handleProgressUpdate({ tab: { id: 1 } } as chrome.runtime.MessageSender, {
        percent: 10, scrollY: 0, pageHeight: 100, activeSecondsDelta: 1,
        doc: { url, title: 'Focus workspace' },
      });
      expect(store.readingProgress).toEqual({});
    },
  );

  it('leaves an existing entry untouched when its tracked tab now shows the new tab', async () => {
    const seeded = {
      url: 'https://example.com/a', feedItemId: null, title: 'A', source: '', maxPercent: 20,
      scrollY: 10, pageHeight: 1000, activeSeconds: 3, firstOpenedAt: 1, updatedAt: Date.now(), completedAt: null,
    };
    store.readingProgress = { 'example.com/a': seeded };
    store.trackedTabs = { 1: { normalizedUrl: 'example.com/a' } };
    await handleProgressUpdate(
      { tab: { id: 1, url: 'chrome-extension://abc/src/pages/newtab/index.html', title: 'Focus workspace' } } as chrome.runtime.MessageSender,
      { percent: 50, scrollY: 0, pageHeight: 1000, activeSecondsDelta: 5 },
    );
    expect(store.readingProgress).toEqual({ 'example.com/a': seeded });
  });
});
