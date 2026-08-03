import { describe, expect, it } from 'vitest';
import type { XBookmark } from '../shared/types';
import { isXBookmarksUrl, mergeXBookmarks } from './xBookmarks';

const item = (id: string, capturedAt: number, text = id): XBookmark => ({
  id,
  url: `https://x.com/user/status/${id}`,
  text,
  authorName: 'User',
  authorHandle: '@user',
  postedAt: null,
  capturedAt,
});

describe('isXBookmarksUrl', () => {
  it('accepts only X and Twitter bookmark routes', () => {
    expect(isXBookmarksUrl('https://x.com/i/bookmarks')).toBe(true);
    expect(isXBookmarksUrl('https://twitter.com/i/bookmarks?ref=nav')).toBe(true);
    expect(isXBookmarksUrl('https://x.com/home')).toBe(false);
    expect(isXBookmarksUrl('https://x.com.evil.test/i/bookmarks')).toBe(false);
  });
});

describe('mergeXBookmarks', () => {
  it('updates visible items, retains unloaded ones, and sorts by capture time', () => {
    expect(mergeXBookmarks([item('1', 10, 'old'), item('2', 20)], [item('1', 30, 'new')])).toEqual([
      item('1', 30, 'new'),
      item('2', 20),
    ]);
  });
});
