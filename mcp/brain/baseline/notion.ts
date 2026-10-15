/**
 * Pure helpers for the step 0 baseline: which Notion page a URL shows, Chrome's
 * timestamps, and the link measure over Notion's own block records. Nothing
 * here reads a file; the commands do that.
 */

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
