/**
 * Feed suggestions from browsing history (idea from ThariqS/ai-newtab, kept on
 * the machine): the sites you actually visit are better suggestions than any
 * sample list, and most of them already say where their feed is.
 *
 * Pure parts first; the browser IO is injected further down so every failure
 * path is a unit test.
 */

export const DAY = 24 * 60 * 60_000;
/** A site seen once is a link someone sent you, not something you follow. */
export const MIN_VISITS = 2;

export interface HistoryVisit {
  url?: string;
  title?: string;
  lastVisitTime?: number;
  visitCount?: number;
}

export interface SiteScore {
  /** Host without `www.`, port kept: 127.0.0.1:8080 and :9090 are different sites */
  host: string;
  /** Origin of the most recent visit; the front page is fetched from here */
  origin: string;
  /** Sum of visitCount, which Chrome counts over all time per URL */
  visits: number;
  pages: number;
  lastVisit: number;
  score: number;
}

/**
 * Relevance = frequency 40% + recency 30% + page variety 20% + visits per day
 * 10%, each capped at 1 (ai-newtab lib/history.ts). Ties go to the host name so
 * the order is stable.
 */
export function rankDomains(items: readonly HistoryVisit[], now: number, days: number): SiteScore[] {
  const sites = new Map<string, SiteScore>();
  const pagesSeen = new Map<string, Set<string>>();
  for (const item of items) {
    if (!item.url) continue;
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const host = url.host.replace(/^www\./, '');
    let site = sites.get(host);
    if (!site) {
      site = { host, origin: url.origin, visits: 0, pages: 0, lastVisit: 0, score: 0 };
      sites.set(host, site);
      pagesSeen.set(host, new Set());
    }
    site.visits += Math.max(1, item.visitCount ?? 1);
    const pages = pagesSeen.get(host)!;
    if (!pages.has(item.url)) {
      pages.add(item.url);
      site.pages++;
    }
    const last = item.lastVisitTime ?? 0;
    if (last >= site.lastVisit) {
      site.lastVisit = last;
      site.origin = url.origin;
    }
  }

  const span = Math.max(1, days);
  const ranked = [...sites.values()].filter((s) => s.visits >= MIN_VISITS);
  for (const site of ranked) {
    const recency = Math.max(0, 1 - (now - site.lastVisit) / (span * DAY));
    site.score =
      Math.min(site.visits / 50, 1) * 0.4 +
      recency * 0.3 +
      Math.min(site.pages / 10, 1) * 0.2 +
      Math.min(site.visits / span / 5, 1) * 0.1;
  }
  return ranked.sort((a, b) => b.score - a.score || a.host.localeCompare(b.host));
}

const FEED_TYPE = /^application\/(rss|atom)\+xml$/i;
const LINK_TAG = /<link\b[^>]*>/gi;
const BASE_TAG = /<base\b[^>]*>/i;
const ATTR = /([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

const decodeEntities = (s: string) => s.replace(/&amp;|&#38;|&#x26;/gi, '&');

function webUrl(href: string, base: string): string | null {
  try {
    const url = new URL(decodeEntities(href), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Every feed a page advertises (`<link rel="alternate" type="application/rss+xml">`
 * or Atom), absolute, deduplicated, in page order. Regex rather than DOMParser
 * because the service worker has no DOM, and only `<link>` tags matter.
 */
export function feedLinks(html: string, base: string): string[] {
  const baseHref = attributes(BASE_TAG.exec(html)?.[0] ?? '').href;
  const root = (baseHref && webUrl(baseHref, base)) || base;
  const out = new Set<string>();
  for (const [tag] of html.matchAll(LINK_TAG)) {
    const attrs = attributes(tag);
    if (!/(^|\s)alternate(\s|$)/i.test(attrs.rel ?? '')) continue;
    if (!FEED_TYPE.test((attrs.type ?? '').trim())) continue;
    if (!attrs.href) continue;
    const href = webUrl(attrs.href, root);
    if (href) out.add(href);
  }
  return [...out];
}

/** How far one "Suggest from my history" run goes. */
export const DISCOVERY = {
  days: 7,
  sites: 12,
  concurrency: 4,
  timeoutMs: 8000,
  /** Feed links live in <head>; half a megabyte is far past it on any real page */
  maxBytes: 512 * 1024,
};

export interface FetchedPage {
  /** Final URL after redirects; relative feed links resolve against it */
  url: string;
  status: number;
  text: string;
}

/**
 * GET a page without cookies, reading at most `maxBytes`. Cookies are omitted
 * so a suggestion never depends on, or reveals, a signed-in session.
 */
export async function fetchCapped(url: string, signal: AbortSignal, maxBytes = DISCOVERY.maxBytes): Promise<FetchedPage> {
  const res = await fetch(url, {
    signal,
    credentials: 'omit',
    redirect: 'follow',
    headers: { accept: 'text/html,application/xhtml+xml' },
  });
  let text = '';
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (bytes < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        // A server may send the whole body as one chunk; keep only what fits.
        const take = value.subarray(0, maxBytes - bytes);
        bytes += take.byteLength;
        text += decoder.decode(take, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  return { url: res.url || url, status: res.status, text };
}

export interface DiscoveryDeps {
  searchHistory(startTime: number): Promise<HistoryVisit[]>;
  fetchPage(url: string, signal: AbortSignal): Promise<FetchedPage>;
  now(): number;
  /** Per-site timeout; DISCOVERY.timeoutMs unless a test needs it short */
  timeoutMs?: number;
}

export interface Suggestion {
  feedUrl: string;
  host: string;
  visits: number;
}

export interface DiscoveryResult {
  suggestions: Suggestion[];
  /** Sites whose front page was asked for */
  checked: number;
  /** Of those, how many failed, timed out or answered with an error status */
  unreachable: number;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** feeds.arstechnica.com follows arstechnica.com, and the other way round. */
export function isFollowed(host: string, followedHosts: readonly string[]): boolean {
  return followedHosts.some((f) => f === host || f.endsWith(`.${host}`) || host.endsWith(`.${f}`));
}

const LOCAL_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/i;
const PRIVATE_V4 = /^(127|10|0)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./;

/**
 * Only public sites are worth a front-page request. A dev server, the router's
 * admin page or an intranet wiki in your history never has a feed worth
 * suggesting, and probing them would surprise anyone (and can raise Chrome's
 * local-network prompt). IPv6 literals are skipped outright.
 */
export function isPublicHost(host: string): boolean {
  if (host.startsWith('[')) return false;
  const name = host.replace(/:\d+$/, '');
  if (!name.includes('.') || LOCAL_SUFFIX.test(name)) return false;
  return !PRIVATE_V4.test(name);
}

async function pool<T>(items: readonly T[], size: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      await run(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

/**
 * Rank the last week of history, skip what is already followed, read the top
 * sites' front pages, and keep the first feed each one advertises. Results are
 * in rank order whatever order the fetches finish in. Aborting rejects with
 * the signal's AbortError; a single site failing never does.
 */
export async function suggestFeeds(
  deps: DiscoveryDeps,
  followedFeeds: readonly string[],
  signal: AbortSignal,
): Promise<DiscoveryResult> {
  const now = deps.now();
  const history = await deps.searchHistory(now - DISCOVERY.days * DAY);
  signal.throwIfAborted();

  const followed = new Set(followedFeeds);
  const followedHosts = followedFeeds.map(hostOf).filter((h): h is string => h !== null);
  const sites = rankDomains(history, now, DISCOVERY.days)
    .filter((s) => isPublicHost(s.host) && !isFollowed(s.host, followedHosts))
    .slice(0, DISCOVERY.sites);

  const found: (string | null)[] = sites.map(() => null);
  let unreachable = 0;
  await pool(sites, DISCOVERY.concurrency, async (site, i) => {
    signal.throwIfAborted();
    try {
      const timeout = AbortSignal.timeout(deps.timeoutMs ?? DISCOVERY.timeoutMs);
      const fetched = await deps.fetchPage(`${site.origin}/`, AbortSignal.any([signal, timeout]));
      if (fetched.status >= 400) {
        unreachable++;
        return;
      }
      found[i] = feedLinks(fetched.text, fetched.url).find((f) => !followed.has(f)) ?? null;
    } catch {
      if (signal.aborted) throw signal.reason;
      unreachable++;
    }
  });
  signal.throwIfAborted();

  const seen = new Set<string>();
  const suggestions: Suggestion[] = [];
  sites.forEach((site, i) => {
    const feedUrl = found[i];
    if (!feedUrl || seen.has(feedUrl)) return;
    seen.add(feedUrl);
    suggestions.push({ feedUrl, host: site.host, visits: site.visits });
  });
  return { suggestions, checked: sites.length, unreachable };
}

/**
 * What someone typed into Add Feed, as an http(s) URL: `lwn.net` becomes
 * `https://lwn.net/`. Anything that is not a plausible web address is null.
 */
export function withScheme(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const explicit = /^https?:\/\//i.test(trimmed);
  const candidate = explicit ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    // A typed scheme means any host goes (a NAS, an IPv6 literal); a guessed
    // one needs something that looks like a site, or "hello" becomes a URL.
    const plausibleHost = explicit || url.hostname.includes('.') || url.hostname === 'localhost';
    return (url.protocol === 'http:' || url.protocol === 'https:') && plausibleHost ? url.href : null;
  } catch {
    return null;
  }
}

/** The first feed a page links to, or null if it links none or cannot be read. */
export async function findFeedOnPage(
  url: string,
  fetchPage: (url: string, signal: AbortSignal) => Promise<FetchedPage> = fetchCapped,
): Promise<string | null> {
  try {
    const fetched = await fetchPage(url, AbortSignal.timeout(DISCOVERY.timeoutMs));
    return fetched.status < 400 ? (feedLinks(fetched.text, fetched.url)[0] ?? null) : null;
  } catch {
    return null;
  }
}
