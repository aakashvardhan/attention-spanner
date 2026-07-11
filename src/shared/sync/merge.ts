import type {
  AnyProgress,
  DayStats,
  Gamification,
  LifetimeCounters,
  SrsDayStats,
  SyncMeta,
} from '../types';

/**
 * Cloud-sync merge spec. Pure, dependency-free functions that reconcile a local
 * record/collection with the remote (Firestore) copy. This module is the single
 * source of truth for conflict resolution; the iOS `SyncMerge.swift` port must
 * produce identical outcomes for the shared test-vector fixtures.
 *
 * Three record shapes, three strategies:
 *  1. User-authored records (tasks, notes, bookmarks, decks, flashNotes,
 *     flashCards, papers) → last-write-wins by `updatedAt`, tombstone wins ties.
 *  2. Time-series aggregates (day stats, SRS day stats, reading progress) →
 *     field-wise `max`. We deliberately use max, never sum: without per-event
 *     ids there is no way to dedup, and the pull→merge→push loop would double
 *     count a summed field. Max never over-counts and still lets any device
 *     cross a daily threshold (streak qualification only needs the max).
 *  3. Monotonic aggregates (gamification xp/counters) → `max` per field;
 *     badges → union keeping the earliest unlock.
 *
 * Derived values (currentStreak, longestStreak, level, due counts) are NOT
 * merged here — each device recomputes them from the merged primitives.
 */

/** Any synced, id-addressable, user-authored record. */
type SyncRecord = SyncMeta & { id: string };

const ts = (r: SyncMeta): number => r.updatedAt ?? 0;
const isTombstone = (r: SyncMeta): boolean => r.deletedAt != null;

/**
 * Reconcile two versions of the same record. Higher `updatedAt` wins; on a tie
 * a tombstone beats a live record so deletes are not resurrected. Commutative
 * except for two genuinely-equal versions (same ts, same tombstone state),
 * where it returns `local` — those are treated as equivalent.
 */
export function mergeRecord<T extends SyncRecord>(local: T, remote: T): T {
  const lt = ts(local);
  const rt = ts(remote);
  if (rt > lt) return remote;
  if (lt > rt) return local;
  // Equal timestamps: tombstone wins.
  if (isTombstone(remote) && !isTombstone(local)) return remote;
  return local;
}

/**
 * Merge two collections keyed by `id`. Overlapping ids are reconciled with
 * `mergeRecord`; records present on only one side carry through. Tombstones are
 * retained in the output so deletes propagate — callers filter them out of read
 * paths, and a periodic sweep purges tombstones older than the retention window.
 */
export function mergeById<T extends SyncRecord>(local: T[], remote: T[]): T[] {
  const byId = new Map<string, T>();
  for (const r of local) byId.set(r.id, r);
  for (const r of remote) {
    const existing = byId.get(r.id);
    byId.set(r.id, existing ? mergeRecord(existing, r) : r);
  }
  return [...byId.values()];
}

/** Live (non-tombstoned) records, for read paths and rendering. */
export function live<T extends SyncMeta>(records: T[]): T[] {
  return records.filter((r) => !isTombstone(r));
}

/** Drop tombstones whose delete is older than `olderThanMs` (retention sweep). */
export function sweepTombstones<T extends SyncMeta>(records: T[], now: number, olderThanMs: number): T[] {
  return records.filter((r) => r.deletedAt == null || now - r.deletedAt < olderThanMs);
}

/** Order-preserving union of two string sets (feeds, readItems). */
export function mergeStringSet(local: string[], remote: string[]): string[] {
  const seen = new Set(local);
  const out = [...local];
  for (const s of remote) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

const max = (a: number | undefined, b: number | undefined): number =>
  Math.max(a ?? 0, b ?? 0);

/** Field-wise max of two same-day DayStats (optional fields default to 0). */
export function mergeDayStats(local: DayStats, remote: DayStats): DayStats {
  return {
    minutes: max(local.minutes, remote.minutes),
    sprints: max(local.sprints, remote.sprints),
    articlesFinished: max(local.articlesFinished, remote.articlesFinished),
    videosFinished: max(local.videosFinished, remote.videosFinished),
    focusBlocks: max(local.focusBlocks, remote.focusBlocks),
    tasksCompleted: max(local.tasksCompleted, remote.tasksCompleted),
  };
}

/** Per-deck-key max of the two review/new-introduced maps. */
export function mergeSrsDayStats(local: SrsDayStats, remote: SrsDayStats): SrsDayStats {
  return {
    reviews: mergeNumberMap(local.reviews, remote.reviews),
    newIntroduced: mergeNumberMap(local.newIntroduced, remote.newIntroduced),
  };
}

/** Per-key max of two `Record<string, number>` maps. */
export function mergeNumberMap(
  local: Record<string, number>,
  remote: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...local };
  for (const [k, v] of Object.entries(remote)) out[k] = max(out[k], v);
  return out;
}

/**
 * Merge two date-keyed maps (streaks.daily, srsDaily, gym.checkins) using
 * `mergeValue` for keys present on both sides.
 */
export function mergeDatedMap<V>(
  local: Record<string, V>,
  remote: Record<string, V>,
  mergeValue: (a: V, b: V) => V,
): Record<string, V> {
  const out: Record<string, V> = { ...local };
  for (const [day, v] of Object.entries(remote)) {
    out[day] = day in out ? mergeValue(out[day], v) : v;
  }
  return out;
}

/** Per-field max of lifetime counters (monotonic, so max is safe). */
export function mergeCounters(local: LifetimeCounters, remote: LifetimeCounters): LifetimeCounters {
  return {
    workouts: max(local.workouts, remote.workouts),
    articlesFinished: max(local.articlesFinished, remote.articlesFinished),
    videosFinished: max(local.videosFinished, remote.videosFinished),
    sprints: max(local.sprints, remote.sprints),
    tasksCompleted: max(local.tasksCompleted, remote.tasksCompleted),
    brainDumps: max(local.brainDumps, remote.brainDumps),
    focusBlocks: max(local.focusBlocks, remote.focusBlocks),
    cardsReviewed: max(local.cardsReviewed, remote.cardsReviewed),
    chestsOpened: max(local.chestsOpened, remote.chestsOpened),
  };
}

/** Union of two badge maps, keeping the earliest unlock timestamp per badge. */
export function mergeBadges(
  local: Record<string, number>,
  remote: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...local };
  for (const [id, at] of Object.entries(remote)) {
    out[id] = id in out ? Math.min(out[id], at) : at;
  }
  return out;
}

/** Merge the singleton gamification doc: xp/counters max, badges union. */
export function mergeGamification(local: Gamification, remote: Gamification): Gamification {
  return {
    xp: max(local.xp, remote.xp),
    badges: mergeBadges(local.badges, remote.badges),
    // Week keys are ISO 'YYYY-MM-DD' (Monday), so lexical max = most recent.
    lastQuestCelebratedWeek:
      local.lastQuestCelebratedWeek >= remote.lastQuestCelebratedWeek
        ? local.lastQuestCelebratedWeek
        : remote.lastQuestCelebratedWeek,
    counters: mergeCounters(local.counters, remote.counters),
  };
}

/**
 * Merge two reading/video progress entries for the same URL. Progress metrics
 * take the max (maxPercent is monotonic by contract); the earliest open and
 * completion are kept; type-specific position fields come from whichever record
 * was updated more recently.
 */
export function mergeProgress<T extends AnyProgress>(local: T, remote: T): T {
  const newer = ts(remote) >= ts(local) ? remote : local;
  return {
    ...newer,
    maxPercent: max(local.maxPercent, remote.maxPercent),
    activeSeconds: max(local.activeSeconds, remote.activeSeconds),
    firstOpenedAt: Math.min(local.firstOpenedAt, remote.firstOpenedAt),
    updatedAt: max(local.updatedAt, remote.updatedAt),
    completedAt: earliestNonNull(local.completedAt, remote.completedAt),
    nudge: {
      count: max(local.nudge.count, remote.nudge.count),
      lastAt: max(local.nudge.lastAt, remote.nudge.lastAt),
      dismissed: local.nudge.dismissed || remote.nudge.dismissed,
    },
  };
}

function earliestNonNull(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}
