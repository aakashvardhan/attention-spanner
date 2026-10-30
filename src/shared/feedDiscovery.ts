/**
 * Finding a page's feed for Add New Feed: most sites say where theirs is.
 * The browser IO is injectable so every failure path is a unit test.
 */

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

/** Limits for one feed lookup. */
export const DISCOVERY = {
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
