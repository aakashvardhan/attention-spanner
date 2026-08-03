import type { AnyProgress, DayStats, SrsDayStats, SyncMeta } from '../types';
import {
  mergeById,
  mergeDatedMap,
  mergeDayStats,
  mergeNumberMap,
  mergeProgress,
  mergeSrsDayStats,
  mergeStringSet,
} from './merge';

/**
 * Declarative map of what syncs to Firestore and how it merges. Pure — no
 * chrome/Firebase here; `src/background/sync.ts` drives this against a transport
 * backend, and the iOS repositories mirror the same layout and merge rules.
 *
 * Firestore layout (all under `users/{uid}/`):
 *   RECORD_COLLECTIONS[k]/{id}   ← id-addressable records, mergeById (LWW+tombstone)
 *   readingProgress/{urlKey}     ← per-url AnyProgress, mergeProgress
 *   dayStats/{YYYY-MM-DD}        ← streaks.daily, mergeDayStats
 *   srsDaily/{YYYY-MM-DD}        ← srsDaily, mergeSrsDayStats
 *   gymCheckins/{YYYY-MM-DD}     ← gym.checkins, per-day max
 *   feeds (doc: meta/feeds)      ← feed url list, set-union
 *   gamification (doc: meta/gamification) ← merged in merge.ts::mergeGamification
 *
 * Not synced (v1): settings (no timestamp yet + holds secrets),
 * cachedItems/cacheTimestamp (refetchable), readItems, the `sync`
 * control state, `notesVault`, `recordings`, `graphNodes`, `gmail`, the four
 * assistant keys (`assistantMemory`, `assistantSkills`, `assistantAutomations`,
 * `assistantJournal`, `assistantProfile`, `weekReviews`), and all of
 * SessionSchema.
 *
 * `gmail` is excluded for the hardest reason on this list: it holds live OAuth
 * refresh tokens for the user's mail. Syncing it would put standing access to
 * an inbox in Firestore, where a single leaked document is a mailbox. The
 * triage output rides along in the same key and is metadata about that mail,
 * so it stays put too — reconnecting a mailbox on a second device is a
 * thirty-second cost and the right one.
 *
 * `graphNodes` follows `recordings` out the door, and for a sharper reason: a
 * recording's node carries its title, so syncing the index would quietly undo
 * the decision below. LWW is also simply the wrong merge here — two devices
 * prune `readingProgress` on different schedules, so their node sets are both
 * correct and different, and last-write-wins would let the machine you used
 * yesterday delete the graph built on the one you use for work. The cost,
 * accepted: article and video history is per-device. Papers and bookmarks
 * already sync, and their nodes are rebuilt by the reconcile on any device.
 *
 * `recordings` is excluded for the same reason `notesVault` is — not because it
 * is hard, but because it should not leave the device. A transcript is a verbatim
 * record of a lecture or a meeting, often of people who did not choose to be
 * stored in anyone's Firestore. Transcribing sends audio to Gemini once and
 * keeps the text locally; syncing would turn that into a permanent second copy.
 *
 * `notesVault` is excluded deliberately, not incidentally. Once brain-dump
 * encryption is on, `notes` records carry AES-256-GCM ciphertext in their
 * enc* fields and sync as opaque blobs — which is the point, since the cloud
 * copy is then unreadable. Keeping the key device-local means a Firestore
 * breach yields nothing to attack offline. The cost is that a second device,
 * and the iOS port, will see the rows but cannot open them.
 */

/** Id-addressable, user-authored collections merged with LWW + tombstones. */
export const RECORD_COLLECTIONS = [
  'tasks',
  'notes',
  'bookmarks',
  'bookmarkGroups',
  'decks',
  'flashNotes',
  'flashCards',
  'papers',
] as const;

export type RecordCollection = (typeof RECORD_COLLECTIONS)[number];

/** Any synced, id-addressable record. */
export type SyncRecord = SyncMeta & { id: string };

/** Reconcile one id-addressable collection (thin alias so callers import here). */
export function mergeRecordCollection<T extends SyncRecord>(local: T[], remote: T[]): T[] {
  return mergeById(local, remote);
}

/** Feed url list — order-preserving set union. */
export function mergeFeeds(local: string[], remote: string[]): string[] {
  return mergeStringSet(local, remote);
}

/** Per-url reading/video progress map. */
export function mergeReadingProgress(
  local: Record<string, AnyProgress>,
  remote: Record<string, AnyProgress>,
): Record<string, AnyProgress> {
  return mergeDatedMap(local, remote, mergeProgress);
}

/** streaks.daily: per-day field-wise max. */
export function mergeStreakDaily(
  local: Record<string, DayStats>,
  remote: Record<string, DayStats>,
): Record<string, DayStats> {
  return mergeDatedMap(local, remote, mergeDayStats);
}

/** srsDaily: per-day, per-deck max. */
export function mergeSrsDaily(
  local: Record<string, SrsDayStats>,
  remote: Record<string, SrsDayStats>,
): Record<string, SrsDayStats> {
  return mergeDatedMap(local, remote, mergeSrsDayStats);
}

/** gym.checkins: per-day max (one check-in timestamp per day). */
export function mergeGymCheckins(
  local: Record<string, number>,
  remote: Record<string, number>,
): Record<string, number> {
  return mergeNumberMap(local, remote);
}

/*
 * Tombstones. Record collections locally hold only LIVE records — read paths
 * never see deletions. Deletions are tracked out-of-band in a single map keyed
 * `${collection}:${id}` → deletedAt (ms), synced as one Firestore doc. The sync
 * layer infers this map by diffing storage changes, so feature modules and UI
 * stay unaware of it. A pulled tombstone removes the id from its local array; a
 * re-created id (same key reappears) clears its tombstone (un-delete).
 */

export type TombstoneMap = Record<string, number>;

export function tombstoneKey(collection: RecordCollection, id: string): string {
  return `${collection}:${id}`;
}

/** Ids present in `before` but gone from `after`, and vice-versa. */
export function diffIds(
  before: SyncRecord[],
  after: SyncRecord[],
): { added: string[]; removed: string[] } {
  const beforeIds = new Set(before.map((r) => r.id));
  const afterIds = new Set(after.map((r) => r.id));
  return {
    added: [...afterIds].filter((id) => !beforeIds.has(id)),
    removed: [...beforeIds].filter((id) => !afterIds.has(id)),
  };
}

/** Union of two tombstone maps, keeping the latest deletion time per key. */
export function mergeTombstones(local: TombstoneMap, remote: TombstoneMap): TombstoneMap {
  const out: TombstoneMap = { ...local };
  for (const [key, at] of Object.entries(remote)) {
    out[key] = Math.max(out[key] ?? 0, at);
  }
  return out;
}

/** Drop tombstones older than `ttlMs` so the map cannot grow without bound. */
export function sweepTombstoneMap(map: TombstoneMap, now: number, ttlMs: number): TombstoneMap {
  const out: TombstoneMap = {};
  for (const [key, at] of Object.entries(map)) {
    if (now - at < ttlMs) out[key] = at;
  }
  return out;
}
