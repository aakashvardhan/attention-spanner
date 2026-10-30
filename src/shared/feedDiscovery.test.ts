import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  feedLinks,
  fetchCapped,
  findFeedOnPage,
  withScheme,
  type FetchedPage,
} from './feedDiscovery';

describe('feedLinks', () => {
  const base = 'https://blog.example/posts/';

  it('finds RSS and Atom alternates and resolves relative hrefs', () => {
    const html = `<head>
      <link rel="alternate" type="application/rss+xml" href="/feed.xml">
      <link rel='alternate' TYPE='Application/Atom+XML' href='atom.xml'>
    </head>`;
    expect(feedLinks(html, base)).toEqual(['https://blog.example/feed.xml', 'https://blog.example/posts/atom.xml']);
  });

  it('ignores alternates that are not feeds and links that are not alternates', () => {
    const html = `<link rel="alternate" hreflang="de" type="text/html" href="/de/">
      <link rel="stylesheet" type="application/rss+xml" href="/x.xml">
      <link rel="alternate" type="application/rss+xml">`;
    expect(feedLinks(html, base)).toEqual([]);
  });

  it('accepts rel lists, unquoted attributes and HTML entities in hrefs', () => {
    const html = `<link rel="home alternate" type=application/rss+xml href="/feed?a=1&amp;b=2">`;
    expect(feedLinks(html, base)).toEqual(['https://blog.example/feed?a=1&b=2']);
  });

  it('respects a <base href> and drops non-web schemes and duplicates', () => {
    const html = `<base href="https://cdn.example/root/">
      <link rel="alternate" type="application/rss+xml" href="feed.xml">
      <link rel="alternate" type="application/rss+xml" href="https://cdn.example/root/feed.xml">
      <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">`;
    expect(feedLinks(html, base)).toEqual(['https://cdn.example/root/feed.xml']);
  });

  it('scans a 2 MB page quickly', () => {
    const html = `<link rel="alternate" type="application/rss+xml" href="/f.xml">` + '<p>filler</p>'.repeat(170_000);
    const start = performance.now();
    expect(feedLinks(html, base)).toHaveLength(1);
    expect(performance.now() - start).toBeLessThan(150);
  });
});

const page = (url: string, body: string, status = 200): FetchedPage => ({ url, status, text: body });
const feedPage = (url: string, href: string) => page(url, `<link rel="alternate" type="application/rss+xml" href="${href}">`);

describe('fetchCapped', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('omits credentials and stops reading at the byte cap', async () => {
    const init: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
      init.push(options);
      return new Response('x'.repeat(2_000_000), { status: 200 });
    });
    const result = await fetchCapped('https://big.example/', new AbortController().signal, 100_000);
    expect(init[0].credentials).toBe('omit');
    expect(result.text.length).toBeLessThan(200_000);
    expect(result.status).toBe(200);
  });
});

describe('withScheme', () => {
  it('adds https to a bare site, keeps explicit http(s), rejects the rest', () => {
    expect(withScheme('lwn.net')).toBe('https://lwn.net/');
    expect(withScheme('  http://site.example/feed ')).toBe('http://site.example/feed');
    expect(withScheme('localhost:8080')).toBe('https://localhost:8080/');
    expect(withScheme('')).toBeNull();
    expect(withScheme('not a site')).toBeNull();
    expect(withScheme('ftp://x.example/')).toBeNull();
    expect(withScheme('javascript:alert(1)')).toBeNull();
  });

  it('keeps an explicit http(s) URL on an intranet, LAN or IPv6 host', () => {
    expect(withScheme('http://nas:8080/rss')).toBe('http://nas:8080/rss');
    expect(withScheme('http://[::1]:8080/feed')).toBe('http://[::1]:8080/feed');
    expect(withScheme('nas')).toBeNull();
  });
});

describe('findFeedOnPage', () => {
  it('returns the first advertised feed, or null on failure or error status', async () => {
    expect(await findFeedOnPage('https://a.example/', async (url) => feedPage(url, '/rss'))).toBe('https://a.example/rss');
    expect(await findFeedOnPage('https://a.example/', async (url) => page(url, '', 500))).toBeNull();
    expect(
      await findFeedOnPage('https://a.example/', async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).toBeNull();
  });
});
