import { getSession, setSession } from '../storage';

/**
 * Two-tier assistant response cache.
 *
 * Tier 1: an in-memory LRU per JS context (newtab, popup, offscreen doc, SW)
 * for zero-cost repeat hits. Tier 2: chrome.storage.session, shared across
 * contexts (the offscreen doc reaches it via PROXY_STORAGE — one message hop
 * is still far cheaper than an LLM round-trip). Session storage clears with
 * the browser, which is exactly the lifetime cached replies deserve.
 *
 * Entries carry a tag: 'intent' (classification, data-independent) or
 * 'data' (anything derived from the user's data — invalidated on mutation).
 */

export interface CacheEntry {
  v: unknown;
  exp: number;
  tag: string;
}

export const CACHE_MAX_ENTRIES = 150;
/** Session-storage discipline: never persist bulky values (context caps at 3000 chars) */
export const CACHE_MAX_VALUE_CHARS = 4096;
/**
 * In-memory entries tagged 'data' expire fast: invalidation clears the shared
 * session tier, but another context's hot tier can't be reached — a short
 * memory TTL bounds that staleness to seconds while still deduping bursts.
 */
const MEM_DATA_TTL_CAP_MS = 5000;

export const INTENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const CONTEXT_CACHE_TTL_MS = 30 * 1000;
export const ANSWER_CACHE_TTL_MS = 5 * 60 * 1000;

/** Pure LRU with per-entry expiry (Map iteration order = recency) */
export class LruTtlCache<V> {
  private map = new Map<string, { v: V; exp: number; tag: string }>();

  constructor(private maxEntries: number) {}

  get(key: string, now = Date.now()): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.exp <= now) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key); // refresh recency
    this.map.set(key, entry);
    return entry.v;
  }

  set(key: string, v: V, ttlMs: number, tag: string, now = Date.now()): void {
    this.map.delete(key);
    this.map.set(key, { v, exp: now + ttlMs, tag });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  deleteTag(tag: string): void {
    for (const [key, entry] of this.map) {
      if (entry.tag === tag) this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** Lowercase, collapse whitespace, drop trailing punctuation — cache keys */
export function normalizeUtterance(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?\s]+$/, '');
}

/** FNV-1a — cheap stable hash for cache-key components */
export function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const mem = new LruTtlCache<unknown>(CACHE_MAX_ENTRIES);

/** Session tier is best-effort: vitest has no chrome at all — degrade to memory-only */
async function sessionRead(): Promise<Record<string, CacheEntry>> {
  try {
    const { assistantCache } = await getSession('assistantCache');
    return assistantCache;
  } catch {
    return {};
  }
}

async function sessionWrite(record: Record<string, CacheEntry>): Promise<void> {
  try {
    await setSession({ assistantCache: record });
  } catch {
    // memory tier still works
  }
}

function memTtl(ttlMs: number, tag: string): number {
  return tag === 'data' ? Math.min(ttlMs, MEM_DATA_TTL_CAP_MS) : ttlMs;
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const hot = mem.get(key);
  if (hot !== undefined) return hot as T;
  const record = await sessionRead();
  const entry = record[key];
  if (!entry || entry.exp <= Date.now()) return undefined;
  mem.set(key, entry.v, memTtl(entry.exp - Date.now(), entry.tag), entry.tag);
  return entry.v as T;
}

export async function cacheSet(key: string, value: unknown, ttlMs: number, tag: string): Promise<void> {
  try {
    if (JSON.stringify(value).length > CACHE_MAX_VALUE_CHARS) return;
  } catch {
    return; // unserializable — session tier couldn't hold it anyway
  }
  mem.set(key, value, memTtl(ttlMs, tag), tag);
  const now = Date.now();
  const record = await sessionRead();
  const pruned: Record<string, CacheEntry> = {};
  const live = Object.entries(record).filter(([, e]) => e.exp > now);
  // Oldest-expiry entries go first when over the cap
  live.sort((a, b) => a[1].exp - b[1].exp);
  for (const [k, e] of live.slice(-(CACHE_MAX_ENTRIES - 1))) pruned[k] = e;
  pruned[key] = { v: value, exp: now + ttlMs, tag };
  await sessionWrite(pruned);
}

export async function cacheInvalidateTag(tag: string): Promise<void> {
  mem.deleteTag(tag);
  const record = await sessionRead();
  const kept: Record<string, CacheEntry> = {};
  let dropped = false;
  for (const [k, e] of Object.entries(record)) {
    if (e.tag === tag) dropped = true;
    else kept[k] = e;
  }
  if (dropped) await sessionWrite(kept);
}

/** Test hook: reset the in-memory tier */
export function cacheResetMemory(): void {
  mem.clear();
}
