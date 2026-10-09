import { describe, expect, it } from 'vitest';
import { DAY, feedLinks, rankDomains, type HistoryVisit } from './feedDiscovery';

const now = Date.parse('2026-10-08T12:00:00Z');
const visit = (url: string, visitCount = 1, ago = 0): HistoryVisit => ({ url, visitCount, lastVisitTime: now - ago });

describe('rankDomains', () => {
  it('groups by host, strips www, and keeps ports apart', () => {
    const sites = rankDomains(
      [
        visit('https://www.lwn.net/a', 3),
        visit('https://lwn.net/b', 2),
        visit('http://127.0.0.1:8080/x', 2),
        visit('http://127.0.0.1:9090/y', 2),
      ],
      now,
      7,
    );
    expect(sites.map((s) => [s.host, s.visits, s.pages])).toEqual([
      ['lwn.net', 5, 2],
      ['127.0.0.1:8080', 2, 1],
      ['127.0.0.1:9090', 2, 1],
    ]);
  });

  it('drops sites under two visits, non-web schemes and malformed URLs', () => {
    const sites = rankDomains(
      [visit('https://once.example/', 1), visit('chrome://settings', 9), visit('file:///x.pdf', 9), { url: 'not a url', visitCount: 9 }, {}],
      now,
      7,
    );
    expect(sites).toEqual([]);
  });

  it('counts a missing or zero visitCount as one visit', () => {
    const sites = rankDomains([{ url: 'https://a.example/1', lastVisitTime: now }, { url: 'https://a.example/2', visitCount: 0, lastVisitTime: now }], now, 7);
    expect(sites[0].visits).toBe(2);
  });

  it('fetches from the origin of the most recent visit', () => {
    const sites = rankDomains([visit('http://site.example/old', 2, 3 * DAY), visit('https://site.example/new', 1, 0)], now, 7);
    expect(sites[0].origin).toBe('https://site.example');
  });

  it('ranks frequent, recent, varied sites first and breaks ties by host', () => {
    const sites = rankDomains(
      [
        ...Array.from({ length: 10 }, (_, i) => visit(`https://busy.example/${i}`, 5, 0)),
        visit('https://stale.example/a', 30, 6 * DAY),
        visit('https://b.example/', 2, DAY),
        visit('https://a.example/', 2, DAY),
      ],
      now,
      7,
    );
    expect(sites.map((s) => s.host)).toEqual(['busy.example', 'stale.example', 'a.example', 'b.example']);
  });

  it('ranks 10,000 history items in well under a quarter second', () => {
    const items = Array.from({ length: 10_000 }, (_, i) => visit(`https://site${i % 600}.example/p${i}`, (i % 7) + 1, (i % 7) * DAY));
    const start = performance.now();
    rankDomains(items, now, 7);
    // ponytail: wall-clock budget with ~10x headroom for slow CI runners.
    expect(performance.now() - start).toBeLessThan(250);
  });
});

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
