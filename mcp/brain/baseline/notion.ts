/**
 * Pure helpers for the step 0 baseline: which Notion page a URL shows, Chrome's
 * timestamps, and the link measure over Notion's own block records. Nothing
 * here reads a file; the commands do that.
 */
import type { NBlock } from './notionDb';

export interface PageVisits { visits: number; weeks: Record<string, number>; lastVisit: string }

export const toUuid = (hex: string): string => {
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const NOTION_HOST = /(^|\.)notion\.(so|com|site)$/i;
const TAIL_ID = /([0-9a-f]{32})$/i;

/** The page a Notion URL shows. A side peek (?p=) is the page being read, not the one behind it. */
export function notionPageId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!NOTION_HOST.test(u.hostname)) return null;
  const peek = u.searchParams.get('p');
  const fromPeek = peek ? TAIL_ID.exec(peek.replace(/-/g, '')) : null;
  if (fromPeek) return toUuid(fromPeek[1]);
  const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '').replace(/-/g, '');
  const m = TAIL_ID.exec(last);
  return m ? toUuid(m[1]) : null;
}

/** Chrome stores times as microseconds since 1601-01-01 UTC. */
export const chromeTimeToMs = (t: number): number => t / 1000 - 11644473600000;

/** ISO 8601 week, in UTC so the counts do not move with the machine's time zone. */
export function isoWeek(ms: number): string {
  const d = new Date(ms);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const thursday = day + (3 - ((d.getUTCDay() + 6) % 7)) * 86_400_000;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function aggregateVisits(visits: { id: string | null; ms: number }[]): Record<string, PageVisits> {
  const out: Record<string, PageVisits> = {};
  for (const v of visits) {
    if (!v.id) continue;
    const p = (out[v.id] ??= { visits: 0, weeks: {}, lastVisit: new Date(0).toISOString() });
    p.visits++;
    const w = isoWeek(v.ms);
    p.weeks[w] = (p.weeks[w] ?? 0) + 1;
    if (new Date(v.ms).toISOString() > p.lastVisit) p.lastVisit = new Date(v.ms).toISOString();
  }
  return out;
}

const PAGE_TYPES = new Set(['page', 'collection_view_page']);
const MENTION = /\["p","([0-9a-f-]{36})"/g;

/** Pages a block links to: a link-to-page block, or page mentions in its text and properties. */
export function linkTargets(b: NBlock): string[] {
  const out: string[] = [];
  if (b.type === 'alias' && b.format) {
    try {
      const id = JSON.parse(b.format)?.alias_pointer?.id;
      if (typeof id === 'string') out.push(id);
    } catch {
      // A malformed format is not a link.
    }
  }
  if (b.properties) for (const m of b.properties.matchAll(MENTION)) out.push(m[1]);
  return out;
}

/**
 * The spec's Connections baseline: of the in-scope pages, the share with at
 * least one link in and one link out. Database rows hang off a collection, not
 * a block, so `collectionParents` carries them up to the page that holds it.
 */
export function linkMeasure(
  blocks: NBlock[],
  collectionParents: Map<string, string>,
  scope: { roots?: string[]; exclude?: string[] } = {},
): { pages: number; connected: number; share: number } {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const parent = (id: string) => byId.get(id)?.parent_id ?? collectionParents.get(id) ?? null;
  const roots = new Set(scope.roots ?? []);
  const exclude = new Set(scope.exclude ?? []);
  const inScope = (id: string): boolean => {
    for (let cur: string | null = id, i = 0; cur && i < 500; cur = parent(cur), i++) {
      if (exclude.has(cur)) return false;
      if (roots.has(cur)) return true;
    }
    return roots.size === 0;
  };
  const pageOf = (id: string): string | null => {
    for (let cur: string | null = id, i = 0; cur && i < 500; cur = parent(cur), i++) {
      const b = byId.get(cur);
      if (b && PAGE_TYPES.has(b.type)) return b.id;
    }
    return null;
  };
  const pages = blocks.filter((b) => b.alive && PAGE_TYPES.has(b.type) && inScope(b.id)).map((b) => b.id);
  const scoped = new Set(pages);
  const out = new Set<string>();
  const into = new Set<string>();
  for (const b of blocks) {
    if (!b.alive) continue;
    const src = pageOf(b.id);
    if (!src || !scoped.has(src)) continue;
    for (const t of linkTargets(b)) {
      if (t === src || !scoped.has(t)) continue;
      out.add(src);
      into.add(t);
    }
  }
  const connected = pages.filter((p) => out.has(p) && into.has(p)).length;
  return { pages: pages.length, connected, share: pages.length ? connected / pages.length : 0 };
}

/** Notion keeps a title as runs of [text, annotations]; only the text matters here. */
export function notionTitle(properties: string | null): string {
  if (!properties) return '';
  try {
    const runs = JSON.parse(properties)?.title;
    return Array.isArray(runs) ? runs.map((r: unknown) => (Array.isArray(r) && typeof r[0] === 'string' ? r[0] : '')).join('') : '';
  } catch {
    return '';
  }
}
