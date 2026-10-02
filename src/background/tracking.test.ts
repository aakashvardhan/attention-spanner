import { describe, expect, it } from 'vitest';
import { isKnownUrl } from './tracking';
import type { BookmarkLink, FeedItem } from '../shared/types';

const empty = { readingProgress: {}, cachedItems: [] as FeedItem[], bookmarks: [] as BookmarkLink[] };

function bookmark(url: string): BookmarkLink {
  return { id: 'b1', url, title: 'Saved', groupId: null, createdAt: 0, updatedAt: 0 };
}

describe('isKnownUrl', () => {
  it('recognizes a bookmarked link', () => {
    // Without this the reading tracker was never injected into a link opened
    // from the Links panel, so it could never reach Continue.
    expect(
      isKnownUrl('example.com/guide', {
        ...empty,
        bookmarks: [bookmark('https://example.com/guide')],
      }),
    ).toBe(true);
  });

  it('matches a bookmark whose stored URL needs normalizing', () => {
    expect(
      isKnownUrl('example.com/guide', {
        ...empty,
        bookmarks: [bookmark('https://www.example.com/guide/?utm_source=news#top')],
      }),
    ).toBe(true);
  });

  it('still recognizes feed items and anything already tracked', () => {
    const item = { normalizedLink: 'example.com/post' } as FeedItem;
    expect(isKnownUrl('example.com/post', { ...empty, cachedItems: [item] })).toBe(true);
    expect(
      isKnownUrl('example.com/old', {
        ...empty,
        readingProgress: { 'example.com/old': { maxPercent: 10 } as never },
      }),
    ).toBe(true);
  });

  it('ignores an unrelated page', () => {
    expect(
      isKnownUrl('random.example/thing', {
        ...empty,
        bookmarks: [bookmark('https://example.com/guide')],
      }),
    ).toBe(false);
  });
});
