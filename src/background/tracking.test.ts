import { describe, expect, it } from 'vitest';
import { isKnownUrl } from './tracking';
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
