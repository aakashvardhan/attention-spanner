import { XMLParser } from 'fast-xml-parser';
import { FETCH_TIMEOUT_MS, RSS2JSON_API } from '../shared/constants';
import type { FeedItem } from '../shared/types';
import { normalizeUrl } from '../shared/urlNormalize';

/**
 * Feed fetching + parsing, service-worker safe. The legacy extension used
 * DOMParser in its worker, which doesn't exist there — every background
 * refresh silently fell back to rss2json. fast-xml-parser makes direct
 * parsing the real primary path; rss2json remains the fallback.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  isArray: (_name, jpath) =>
    ['rss.channel.item', 'feed.entry', 'feed.entry.link'].includes(String(jpath)),
});

/** fxp yields strings for plain elements, objects when attributes are present */
function text(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return text((value as Record<string, unknown>)['#text']);
  }
  return '';
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&[a-z]+;|&#\d+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same ID scheme as the legacy extension so readItems history carries over */
export function generateItemId(link: string, title: string): string {
  return btoa(encodeURIComponent(link + title)).slice(0, 32);
}

function toIsoDate(raw: string): string {
  const date = raw ? new Date(raw) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/**
 * RSS `<category>` yields a string (or {#text}); Atom `<category term="...">`
 * yields an object with `@_term`. Either can appear once or repeated (array).
 * Normalize any of those shapes into a deduped list of non-empty labels.
 */
function toCategories(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const labels = values
    .map((value) => {
      const term = (value as Record<string, unknown>)?.['@_term'];
      return text(term !== undefined ? term : value).trim();
    })
    .filter((label) => label.length > 0);
  return [...new Set(labels)];
}

function makeItem(
  link: string,
  title: string,
  pubDate: string,
  description: string,
  source: string,
  categories: string[] = [],
): FeedItem {
  return {
    id: generateItemId(link, title),
    title,
    link,
    normalizedLink: normalizeUrl(link),
    pubDate: toIsoDate(pubDate),
    snippet: stripHtml(description).slice(0, 200),
    source,
    categories,
  };
}

interface AtomLink {
  '@_href'?: string;
  '@_rel'?: string;
}

export function parseFeedXml(xml: string, feedUrl: string): FeedItem[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error('Invalid XML');
  }

  const rss = doc.rss as { channel?: Record<string, unknown> } | undefined;
  const atom = doc.feed as Record<string, unknown> | undefined;

  if (rss?.channel) {
    const channel = rss.channel;
    const feedTitle = text(channel.title) || feedUrl;
    const items = (channel.item as Record<string, unknown>[] | undefined) ?? [];
    return items.map((item) =>
      makeItem(
        text(item.link),
        text(item.title),
        text(item.pubDate),
        text(item.description),
        feedTitle,
        toCategories(item.category),
      ),
    );
  }

  if (atom) {
    const feedTitle = text(atom.title) || feedUrl;
    const entries = (atom.entry as Record<string, unknown>[] | undefined) ?? [];
    return entries.map((entry) => {
      const links = (entry.link as AtomLink[] | undefined) ?? [];
      const alternate = links.find((l) => l['@_rel'] === 'alternate') ?? links[0];
      const link = alternate?.['@_href'] ?? '';
      const updated = text(entry.updated) || text(entry.published);
      const summary = text(entry.summary) || text(entry.content);
      return makeItem(link, text(entry.title), updated, summary, feedTitle, toCategories(entry.category));
    });
  }

  throw new Error('Not a recognized RSS or Atom feed');
}

async function fetchFeedDirect(feedUrl: string): Promise<FeedItem[]> {
  const response = await fetch(feedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseFeedXml(await response.text(), feedUrl);
}

interface Rss2JsonItem {
  title?: string;
  link?: string;
  pubDate?: string;
  description?: string;
  categories?: string[];
}

async function fetchFeedViaApi(feedUrl: string): Promise<FeedItem[]> {
  const apiUrl = RSS2JSON_API + encodeURIComponent(feedUrl);
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = (await response.json()) as {
    status?: string;
    message?: string;
    feed?: { title?: string };
    items?: Rss2JsonItem[];
  };
  if (data.status !== 'ok') throw new Error(data.message || 'API returned error status');

  const feedTitle = data.feed?.title || feedUrl;
  return (data.items ?? []).map((item) =>
    makeItem(
      item.link ?? '',
      item.title ?? '',
      item.pubDate ?? '',
      item.description ?? '',
      feedTitle,
      toCategories(item.categories),
    ),
  );
}

export async function fetchFeed(feedUrl: string): Promise<FeedItem[]> {
  try {
    return await fetchFeedDirect(feedUrl);
  } catch (directError) {
    console.warn(`[feeds] Direct parse failed for ${feedUrl}:`, directError);
  }
  try {
    return await fetchFeedViaApi(feedUrl);
  } catch (apiError) {
    console.warn(`[feeds] All methods failed for ${feedUrl}:`, apiError);
    return [];
  }
}

/** Used by feed validation in options: direct fetch first, rss2json fallback */
export async function validateFeed(url: string): Promise<{ valid: boolean; title: string | null }> {
  try {
    const items = await fetchFeedDirect(url);
    if (items.length > 0) return { valid: true, title: items[0].source };
  } catch {
    // fall through to API
  }
  try {
    const items = await fetchFeedViaApi(url);
    if (items.length > 0) return { valid: true, title: items[0].source };
  } catch {
    // invalid
  }
  return { valid: false, title: null };
}
