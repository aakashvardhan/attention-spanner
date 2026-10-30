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
});
