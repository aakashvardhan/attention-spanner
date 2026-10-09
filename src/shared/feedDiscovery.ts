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
