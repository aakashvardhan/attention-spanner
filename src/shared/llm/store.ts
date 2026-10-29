import {
  AI_CACHE_MAX_ENTRIES,
  AI_RESUME_ADVANCE,
  AI_STATS_MAX_SAMPLES,
} from '../constants';
import { getLocal, setLocal } from '../storage';
import type { AiCacheEntry, AiStats, AnyProgress, Paper } from '../types';

/**
 * The AI cache and the impact counters, written straight from the page rather
 * than through the service worker. Neither carries an invariant: a cache entry
 * lost to two tabs writing at once is regenerated, and a lost count nudges a
 * percentage by a hair. The worker's single-writer rule is for data a feature
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

export async function cacheGet(key: string): Promise<AiCacheEntry | null> {
  const { aiCache } = await getLocal('aiCache');
  return aiCache[key] ?? null;
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

export function recordStat(update: {
  count?: string;
  latency?: AiStats['latencies'][number];
  probe?: AiStats['probes'][number];
}): Promise<void> {
  return serial(async () => {
    const { aiStats } = await getLocal('aiStats');
    if (update.count) aiStats.counts[update.count] = (aiStats.counts[update.count] ?? 0) + 1;
    if (update.latency) {
      aiStats.latencies = [...aiStats.latencies, update.latency].slice(-AI_STATS_MAX_SAMPLES);
    }
    if (update.probe) {
      // One open probe per item: reopening it restarts the measurement.
      aiStats.probes = [
        ...aiStats.probes.filter((p) => p.key !== update.probe!.key),
        update.probe,
      ].slice(-AI_STATS_MAX_SAMPLES);
    }
    await setLocal({ aiStats });
  });
}

/** Read-modify-write of the stats, in the same queue as recordStat. */
export function updateStats(change: (stats: AiStats) => AiStats | null): Promise<void> {
  return serial(async () => {
    const { aiStats } = await getLocal('aiStats');
    const next = change(aiStats);
    if (next) await setLocal({ aiStats: next });
  });
}

/** How long a resume has to show progress before it is scored */
const PROBE_WINDOW_MS = 30 * 60_000;
/** A triage pick gets a week to be finished — articles get read in sittings */
const TRIAGE_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * Score finished resume probes. A probe settles as soon as its item gains
 * AI_RESUME_ADVANCE points, or as a miss once the window passes without it.
 * Pure; the caller writes the result back.
 *
 * `percentOf` answers for a probe key — a readingProgress key, or
 * `paper:<id>` — with 100 meaning finished, or null when the item is gone.
 */
export function settleProbes(
  stats: AiStats,
  percentOf: (key: string) => number | null,
  now: number,
): AiStats {
  const counts = { ...stats.counts };
  const open: AiStats['probes'] = [];
  for (const probe of stats.probes) {
    const percent = percentOf(probe.key);
    if (probe.kind === 'triage') {
      // 'triage.opened' was counted at the click; only the finish is pending.
      if (percent === 100) counts['triage.finished'] = (counts['triage.finished'] ?? 0) + 1;
      else if (now - probe.at < TRIAGE_WINDOW_MS) open.push(probe);
      continue;
    }
    const advanced = percent !== null && percent >= Math.min(100, probe.startPercent + AI_RESUME_ADVANCE);
    if (!advanced && now - probe.at < PROBE_WINDOW_MS) {
      open.push(probe);
      continue;
    }
    const arm = probe.recap ? 'withRecap' : 'withoutRecap';
    counts[`resume.${arm}`] = (counts[`resume.${arm}`] ?? 0) + 1;
    if (advanced) counts[`resume.${arm}.advanced`] = (counts[`resume.${arm}.advanced`] ?? 0) + 1;
  }
  return { ...stats, counts, probes: open };
}

/** The lookup settleProbes wants, over the two places progress lives. */
export function probePercent(
  progress: Record<string, AnyProgress>,
  papers: readonly Paper[],
): (key: string) => number | null {
  return (key) => {
    if (key.startsWith('paper:')) {
      const paper = papers.find((p) => `paper:${p.id}` === key);
      if (!paper) return null;
      return paper.status === 'read' ? 100 : paper.progressPercent;
    }
    const entry = progress[key];
    if (!entry) return null;
    return entry.completedAt !== null ? 100 : entry.maxPercent;
  };
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
