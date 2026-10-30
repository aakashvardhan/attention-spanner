import { AI_CACHE_MAX_ENTRIES } from '../constants';
import { getLocal, setLocal } from '../storage';
import type { AiCacheEntry } from '../types';

/**
 * The AI cache and vectors, written straight from the page rather
 * than through the service worker. Neither carries an invariant: a cache entry
 * lost to two tabs writing at once is regenerated. The worker's single-writer rule is for data a feature
 * depends on.
 *
 * Within one page, though, writes are queued: two read-modify-writes of the
 * same key fired back to back would otherwise lose the first.
 */

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

/** FNV-1a, 32-bit. Cache keys, not security. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

const LIVE_TARGETS = new Set(['claude', 'ollama']);

export async function cacheGet(key: string): Promise<AiCacheEntry | null> {
  const { aiCache } = await getLocal('aiCache');
  const entry = aiCache[key];
  // An entry saved by a target that no longer exists (Gemini) is a miss.
  return entry && LIVE_TARGETS.has(entry.target) ? entry : null;
}

export function cachePut(key: string, entry: AiCacheEntry): Promise<void> {
  return serial(async () => {
    const { aiCache } = await getLocal('aiCache');
    aiCache[key] = entry;
    const keys = Object.keys(aiCache);
    if (keys.length > AI_CACHE_MAX_ENTRIES) {
      keys
        .sort((a, b) => aiCache[a].at - aiCache[b].at)
        .slice(0, keys.length - AI_CACHE_MAX_ENTRIES)
        .forEach((old) => delete aiCache[old]);
    }
    await setLocal({ aiCache });
  });
}

/** Read-modify-write of the vector cache, in the same queue as the rest. */
export function updateVectors(
  change: (vectors: Record<string, string>) => Record<string, string>,
): Promise<void> {
  return serial(async () => {
    const { aiVectors } = await getLocal('aiVectors');
    await setLocal({ aiVectors: change(aiVectors) });
  });
}
