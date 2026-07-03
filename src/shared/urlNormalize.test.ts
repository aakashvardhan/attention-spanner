import { describe, expect, it } from 'vitest';
import { normalizeUrl } from './urlNormalize';

describe('normalizeUrl', () => {
  it('drops the scheme so http and https collapse', () => {
    expect(normalizeUrl('http://example.com/post')).toBe(normalizeUrl('https://example.com/post'));
  });

  it('strips www and lowercases the host', () => {
    expect(normalizeUrl('https://WWW.Example.COM/Post')).toBe('example.com/Post');
  });

  it('preserves path case', () => {
    expect(normalizeUrl('https://example.com/Some/Path')).toBe('example.com/Some/Path');
  });

  it('strips tracking params but keeps meaningful ones', () => {
    expect(
      normalizeUrl('https://blog.com/a?utm_source=x&utm_medium=y&fbclid=z&page=2&gclid=1&ref=hn'),
    ).toBe('blog.com/a?page=2');
  });

  it('sorts remaining query params', () => {
    expect(normalizeUrl('https://blog.com/a?b=2&a=1')).toBe('blog.com/a?a=1&b=2');
    expect(normalizeUrl('https://blog.com/a?a=1&b=2')).toBe(
      normalizeUrl('https://blog.com/a?b=2&a=1'),
    );
  });

  it('drops the hash', () => {
    expect(normalizeUrl('https://blog.com/a#section-3')).toBe('blog.com/a');
  });

  it('collapses trailing slashes', () => {
    expect(normalizeUrl('https://blog.com/a/')).toBe('blog.com/a');
    expect(normalizeUrl('https://blog.com/a//')).toBe('blog.com/a');
    expect(normalizeUrl('https://blog.com/a/')).toBe(normalizeUrl('https://blog.com/a'));
  });

  it('keeps root path as /', () => {
    expect(normalizeUrl('https://blog.com/')).toBe('blog.com/');
    expect(normalizeUrl('https://blog.com')).toBe('blog.com/');
  });

  it('matches a feed link against a decorated tab URL', () => {
    const feedLink = 'https://www.arstechnica.com/space/2026/07/rocket-report/';
    const tabUrl = 'http://arstechnica.com/space/2026/07/rocket-report?utm_source=feed#comments';
    expect(normalizeUrl(feedLink)).toBe(normalizeUrl(tabUrl));
  });

  it('returns non-http(s) URLs untrimmed of structure', () => {
    expect(normalizeUrl('chrome://extensions')).toBe('chrome://extensions');
  });

  it('handles invalid URLs without throwing', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
    expect(normalizeUrl('  MIXED case junk  ')).toBe('mixed case junk');
  });

  it('percent-encodes consistently regardless of input encoding', () => {
    expect(normalizeUrl('https://blog.com/a?q=hello world')).toBe(
      normalizeUrl('https://blog.com/a?q=hello%20world'),
    );
  });
});
