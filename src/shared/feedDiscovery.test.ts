import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DAY,
  feedLinks,
  fetchCapped,
  findFeedOnPage,
  isFollowed,
  rankDomains,
  suggestFeeds,
  withScheme,
  type DiscoveryDeps,
  type FetchedPage,
  type HistoryVisit,
} from './feedDiscovery';

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

const page = (url: string, body: string, status = 200): FetchedPage => ({ url, status, text: body });
const feedPage = (url: string, href: string) => page(url, `<link rel="alternate" type="application/rss+xml" href="${href}">`);

function deps(history: HistoryVisit[], pages: Record<string, () => Promise<FetchedPage>>, extra: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
  return {
    now: () => now,
    searchHistory: async () => history,
    fetchPage: async (url) => {
      const make = pages[url];
      if (!make) throw new TypeError('Failed to fetch');
      return make();
    },
    ...extra,
  };
}

const twice = (url: string) => [visit(url, 3, 0), visit(`${url}x`, 3, 0)];

describe('suggestFeeds', () => {
  it('suggests one feed per site in rank order, with the visit count', async () => {
    const result = await suggestFeeds(
      deps([...twice('https://a.example/'), visit('https://b.example/', 2, DAY)], {
        'https://a.example/': async () => feedPage('https://a.example/', '/rss'),
        'https://b.example/': async () => feedPage('https://b.example/', '/atom.xml'),
      }),
      [],
      new AbortController().signal,
    );
    expect(result).toEqual({
      suggestions: [
        { feedUrl: 'https://a.example/rss', host: 'a.example', visits: 6 },
        { feedUrl: 'https://b.example/atom.xml', host: 'b.example', visits: 2 },
      ],
      checked: 2,
      unreachable: 0,
    });
  });

  it('subdomain feeds count as followed, in both directions', () => {
    expect(isFollowed('arstechnica.com', ['feeds.arstechnica.com'])).toBe(true);
    expect(isFollowed('blog.example.com', ['example.com'])).toBe(true);
    expect(isFollowed('notexample.com', ['example.com'])).toBe(false);
  });

  it('skips followed sites and feeds, and the same feed reached from two sites', async () => {
    const result = await suggestFeeds(
      deps([...twice('https://a.example/'), ...twice('https://b.example/'), ...twice('https://arstechnica.com/')], {
        'https://a.example/': async () => feedPage('https://a.example/', 'https://shared.example/feed'),
        'https://b.example/': async () => feedPage('https://b.example/', 'https://shared.example/feed'),
      }),
      ['https://feeds.arstechnica.com/arstechnica/index'],
      new AbortController().signal,
    );
    expect(result.suggestions.map((s) => s.feedUrl)).toEqual(['https://shared.example/feed']);
    expect(result.checked).toBe(2);
  });

  it('counts failures and error statuses as unreachable and keeps the rest', async () => {
    const result = await suggestFeeds(
      deps([...twice('https://a.example/'), ...twice('https://down.example/'), ...twice('https://gone.example/')], {
        'https://a.example/': async () => feedPage('https://a.example/', '/rss'),
        'https://gone.example/': async () => page('https://gone.example/', 'nope', 404),
      }),
      [],
      new AbortController().signal,
    );
    expect(result.suggestions).toHaveLength(1);
    expect(result).toMatchObject({ checked: 3, unreachable: 2 });
  });

  it('a redirect to a page with no feed link is checked, not unreachable', async () => {
    const result = await suggestFeeds(
      deps(twice('https://news.example/'), {
        'https://news.example/': async () => page('https://consent.example/?continue=news', '<form>Accept cookies</form>'),
      }),
      [],
      new AbortController().signal,
    );
    expect(result).toEqual({ suggestions: [], checked: 1, unreachable: 0 });
  });

  it('a site that never answers times out and counts as unreachable', async () => {
    const hang = (_url: string, signal: AbortSignal) =>
      new Promise<FetchedPage>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    const result = await suggestFeeds(
      { ...deps(twice('https://slow.example/'), {}), fetchPage: hang, timeoutMs: 20 },
      [],
      new AbortController().signal,
    );
    expect(result).toEqual({ suggestions: [], checked: 1, unreachable: 1 });
  });

  it('abort stops the scan and rejects with an AbortError', async () => {
    const controller = new AbortController();
    let calls = 0;
    const history = Array.from({ length: 12 }, (_, i) => twice(`https://s${i}.example/`)).flat();
    const fetchPage = (_url: string, signal: AbortSignal) => {
      calls++;
      if (calls === 2) controller.abort();
      return new Promise<FetchedPage>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    };
    await expect(suggestFeeds({ ...deps(history, {}), fetchPage }, [], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBeLessThanOrEqual(4);
  });

  it('never has more than four requests in flight and checks at most twelve sites', async () => {
    let inFlight = 0;
    let peak = 0;
    const history = Array.from({ length: 20 }, (_, i) => twice(`https://s${i}.example/`)).flat();
    const fetchPage = async (url: string) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return page(url, '');
    };
    const result = await suggestFeeds({ ...deps(history, {}), fetchPage }, [], new AbortController().signal);
    expect(peak).toBeLessThanOrEqual(4);
    expect(result.checked).toBe(12);
  });

  it('empty history checks nothing', async () => {
    expect(await suggestFeeds(deps([], {}), [], new AbortController().signal)).toEqual({ suggestions: [], checked: 0, unreachable: 0 });
  });
});

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
