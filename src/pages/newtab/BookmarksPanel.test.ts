import { describe, expect, it } from 'vitest';
import { normalizeBookmarkUrl } from './BookmarksPanel';

describe('normalizeBookmarkUrl', () => {
  it('adds https to a bare hostname', () => {
    expect(normalizeBookmarkUrl('example.com/reading')).toBe('https://example.com/reading');
  });

  it('preserves valid http and https links', () => {
    expect(normalizeBookmarkUrl('http://example.com')).toBe('http://example.com/');
    expect(normalizeBookmarkUrl('https://example.com?a=1')).toBe('https://example.com/?a=1');
  });

  it('rejects empty, invalid, and non-web links', () => {
    expect(normalizeBookmarkUrl('')).toBeNull();
    expect(normalizeBookmarkUrl('not a url')).toBeNull();
    expect(normalizeBookmarkUrl('javascript:alert(1)')).toBeNull();
  });
});
