import { describe, expect, it } from 'vitest';
import { hueFor, normalizeBookmarkUrl } from './BookmarksPanel';

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

describe('hueFor', () => {
  it('keys on the host, so every page of a site shares a colour', () => {
    expect(hueFor('https://zzz.invalid/a')).toBe(hueFor('https://zzz.invalid/b?x=1'));
    expect(hueFor('https://zzz.invalid')).not.toBe(hueFor('https://other.invalid'));
  });

  it('stays a hue for any input', () => {
    for (const url of ['', 'not a url', 'https://a.b']) {
      const hue = hueFor(url);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});
