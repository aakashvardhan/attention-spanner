import { getLocal, setLocal } from '../shared/storage';
import type { LocalSchema, SyncLocalState } from '../shared/storage';
import {
  diffIds,
  mergeFeeds,
  mergeGymCheckins,
  mergeRecordCollection,
  mergeSrsDaily,
  mergeStreakDaily,
  mergeTombstones,
  RECORD_COLLECTIONS,
  sweepTombstoneMap,
  tombstoneKey,
  type RecordCollection,
  type SyncRecord,
  type TombstoneMap,
} from '../shared/sync/collections';
import { mergeGamification } from '../shared/sync/merge';

/** Tombstones older than this are swept so the map cannot grow unbounded. */
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Cloud-sync orchestration. Transport-agnostic: it reads/writes
 * `chrome.storage.local` and speaks to Firestore only through the injected
 * `SyncBackend`. That seam keeps this module free of the Firebase SDK (so the
 * extension builds without credentials) and unit-testable, and isolates the
 * one credential-dependent file (`firestoreBackend.ts`, added with the project
 * keys) that implements `SyncBackend` with `onSnapshot`/`setDoc`.
 *
 * Loop safety: every record carries `updatedAt`. `pushedVersions` records the
 * version we last pushed OR just applied from a pull; a record is only pushed
 * when its `updatedAt` differs, so a pulled write never echoes back. Doc units
 * (aggregates/singletons) use a JSON hash for the same guard.
 */

type Unsubscribe = () => void;

export interface SyncBackend {
  /** Upsert records into `users/{uid}/{collection}` (id = record.id). */
  pushRecords(collection: string, records: SyncRecord[]): Promise<void>;
  /** Hard-delete record docs from `users/{uid}/{collection}` (tombstone cleanup). */
  deleteRecords(collection: string, ids: string[]): Promise<void>;
  /** Upsert a singleton doc at `users/{uid}/{path}`. */
  pushDoc(path: string, data: unknown): Promise<void>;
  /** Live subscription to a whole collection; fires with the full set. */
  subscribeRecords(collection: string, cb: (records: SyncRecord[]) => void): Unsubscribe;
  /** Live subscription to a singleton doc; `null` until it exists. */
  subscribeDoc(path: string, cb: (data: unknown | null) => void): Unsubscribe;
}

/**
 * A non-record sync unit: an aggregate map or singleton stored as one Firestore
 * doc. `read` extracts the pushable payload from local; `apply` merges a pulled
 * payload back and returns the JSON of the resulting local slice (for the loop
 * guard). Keyed by the LocalSchema keys whose change should trigger a push.
 */
interface DocUnit {
  path: string;
  triggers: (keyof LocalSchema)[];
  read(local: LocalSchema): unknown;
  apply(remote: unknown): Promise<string>;
}

const DOC_UNITS: DocUnit[] = [
  {
    path: 'meta/gamification',
    triggers: ['gamification'],
    read: (l) => l.gamification,
    apply: async (remote) => {
      const { gamification } = await getLocal('gamification');
      const merged = mergeGamification(gamification, remote as LocalSchema['gamification']);
      await setLocal({ gamification: merged });
      return JSON.stringify(merged);
    },
  },
  {
    path: 'meta/feeds',
    triggers: ['feeds'],
    read: (l) => ({ urls: l.feeds }),
    apply: async (remote) => {
      const { feeds } = await getLocal('feeds');
      const urls = (remote as { urls?: string[] })?.urls ?? [];
      const merged = mergeFeeds(feeds, urls);
      await setLocal({ feeds: merged });
      return JSON.stringify(merged);
    },
  },
  // NOTE: readingProgress is intentionally not synced yet. Its map is keyed by
  // full URLs, which are invalid Firestore field names (contain '.', '/'). It
  // has no cross-device consumer until the iOS reading list (Part C.6); when
  // that lands, shard it into a `readingProgress/{urlHash}` collection rather
  // than a single map doc. mergeReadingProgress in collections.ts is ready.
  {
    path: 'meta/dayStats',
    triggers: ['streaks'],
    read: (l) => l.streaks.daily,
    apply: async (remote) => {
      const { streaks } = await getLocal('streaks');
      const daily = mergeStreakDaily(streaks.daily, (remote as LocalSchema['streaks']['daily']) ?? {});
      await setLocal({ streaks: { ...streaks, daily } });
      return JSON.stringify(daily);
    },
  },
  {
    path: 'meta/srsDaily',
    triggers: ['srsDaily'],
    read: (l) => l.srsDaily,
    apply: async (remote) => {
      const { srsDaily } = await getLocal('srsDaily');
      const merged = mergeSrsDaily(srsDaily, (remote as LocalSchema['srsDaily']) ?? {});
      await setLocal({ srsDaily: merged });
      return JSON.stringify(merged);
    },
  },
  {
    path: 'meta/gymCheckins',
    triggers: ['gym'],
    read: (l) => l.gym.checkins,
    apply: async (remote) => {
      const { gym } = await getLocal('gym');
      const checkins = mergeGymCheckins(gym.checkins, (remote as LocalSchema['gym']['checkins']) ?? {});
      await setLocal({ gym: { ...gym, checkins } });
      return JSON.stringify(checkins);
    },
  },
  {
    path: 'meta/tombstones',
    triggers: ['tombstones'],
    read: (l) => l.tombstones,
    apply: async (remote) => {
      const { tombstones } = await getLocal('tombstones');
      const merged = sweepTombstoneMap(
        mergeTombstones(tombstones, (remote as TombstoneMap) ?? {}),
        Date.now(),
        TOMBSTONE_TTL_MS,
      );
      await setLocal({ tombstones: merged });
      // A pulled tombstone must remove the record from its local live array.
      await enforceTombstones(merged);
      return JSON.stringify(merged);
    },
  },
];

const PUSH_DEBOUNCE_MS = 1500;

let backend: SyncBackend | null = null;
let running = false;
const subscriptions: Unsubscribe[] = [];
/** Global record key `${collection}:${id}` → last pushed/applied updatedAt. */
const pushedVersions = new Map<string, number>();
/** Doc unit path → last pushed/applied JSON. */
const pushedDocs = new Map<string, string>();
/** Newly-tombstoned ids per collection, awaiting Firestore doc deletion. */
const pendingDeletes: Partial<Record<RecordCollection, Set<string>>> = {};
const dirty = new Set<keyof LocalSchema>();
let pushTimer: ReturnType<typeof setTimeout> | null = null;

const recKey = (col: string, id: string) => `${col}:${id}`;

/** Install the Firestore (or a fake) transport. Call before `startSync`. */
export function registerSyncBackend(b: SyncBackend): void {
  backend = b;
}

async function patchSyncState(patch: Partial<SyncLocalState>): Promise<void> {
  const { sync } = await getLocal('sync');
  await setLocal({ sync: { ...sync, ...patch } });
}

/**
 * Begin two-way sync for `userId`. Idempotent. Subscribes to every collection/
 * doc for the pull path and arms the push path; the caller wires auth and calls
 * this on sign-in.
 */
export async function startSync(userId: string, email: string | null = null): Promise<void> {
  if (!backend || running) return;
  running = true;
  pushedVersions.clear();
  pushedDocs.clear();
  await patchSyncState({ userId, email, lastError: '' });

  for (const col of RECORD_COLLECTIONS) {
    subscriptions.push(
      backend.subscribeRecords(col, (remote) => void applyRemoteRecords(col, remote)),
    );
  }
  for (const unit of DOC_UNITS) {
    subscriptions.push(
      backend.subscribeDoc(unit.path, (data) => void applyRemoteDoc(unit, data)),
    );
  }

  // Push whatever is already local so a fresh device seeds the cloud.
  markAllDirty();
  schedulePush();
}

/** Tear down sync (sign-out). Local data is untouched. */
export async function stopSync(): Promise<void> {
  running = false;
  for (const off of subscriptions.splice(0)) off();
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  dirty.clear();
  await patchSyncState({ userId: null, email: null });
}

/** Current device sync state, for the options UI. */
export async function getSyncStatus(): Promise<SyncLocalState> {
  return (await getLocal('sync')).sync;
}

/**
 * Startup hook: resume sync if this device is signed in and a transport has
 * been registered. Inert until `firestoreBackend` (added with project keys)
 * calls `registerSyncBackend`.
 */
export async function initSync(): Promise<void> {
  if (!backend) return;
  const { userId } = (await getLocal('sync')).sync;
  if (userId) await startSync(userId);
}

/** storage.onChanged hook (wired in background/index.ts). */
export function onLocalChanged(changes: Record<string, chrome.storage.StorageChange>): void {
  if (!running) return;
  let touched = false;
  for (const key of Object.keys(changes) as (keyof LocalSchema)[]) {
    if (key === 'sync' || key === 'tombstones') continue; // control state / managed here
    if (RECORD_COLLECTIONS.includes(key as RecordCollection)) {
      const col = key as RecordCollection;
      const before = (changes[key].oldValue ?? []) as SyncRecord[];
      const after = (changes[key].newValue ?? []) as SyncRecord[];
      void reconcileTombstones(col, before, after);
      dirty.add(key);
      touched = true;
    } else if (isDocTrigger(key)) {
      dirty.add(key);
      touched = true;
    }
  }
  if (touched) schedulePush();
}

/**
 * Turn record removals/additions into tombstone bookkeeping: an id that left a
 * collection is tombstoned (unless already), one that reappeared clears its
 * tombstone (un-delete, e.g. a flashcard variant reconciled back). Records the
 * newly-dead ids for Firestore cleanup on the next push.
 */
async function reconcileTombstones(
  col: RecordCollection,
  before: SyncRecord[],
  after: SyncRecord[],
): Promise<void> {
  const { added, removed } = diffIds(before, after);
  if (added.length === 0 && removed.length === 0) return;
  const { tombstones } = await getLocal('tombstones');
  const next = { ...tombstones };
  let changed = false;
  const now = Date.now();
  for (const id of removed) {
    const key = tombstoneKey(col, id);
    if (!(key in next)) {
      next[key] = now;
      changed = true;
      (pendingDeletes[col] ??= new Set()).add(id);
    }
  }
  for (const id of added) {
    const key = tombstoneKey(col, id);
    if (key in next) {
      delete next[key];
      changed = true;
      pendingDeletes[col]?.delete(id);
    }
  }
  if (changed) {
    await setLocal({ tombstones: next });
    dirty.add('tombstones');
    schedulePush();
  }
}

/** Remove any tombstoned ids still present in local live arrays. */
async function enforceTombstones(tombstones: TombstoneMap): Promise<void> {
  for (const col of RECORD_COLLECTIONS) {
    const local = (await getLocal(col))[col] as unknown as SyncRecord[];
    const live = local.filter((r) => !(tombstoneKey(col, r.id) in tombstones));
    if (live.length !== local.length) {
      for (const r of local) pushedVersions.set(recKey(col, r.id), r.updatedAt ?? 0);
      await setLocal({ [col]: live } as unknown as Partial<LocalSchema>);
    }
  }
}

function isDocTrigger(key: keyof LocalSchema): boolean {
  return DOC_UNITS.some((u) => u.triggers.includes(key));
}

function markAllDirty(): void {
  for (const col of RECORD_COLLECTIONS) dirty.add(col);
  for (const unit of DOC_UNITS) for (const t of unit.triggers) dirty.add(t);
}

function schedulePush(): void {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void flushPush();
  }, PUSH_DEBOUNCE_MS);
}

async function flushPush(): Promise<void> {
  if (!backend || !running || dirty.size === 0) return;
  const keys = new Set(dirty);
  dirty.clear();
  try {
    for (const col of RECORD_COLLECTIONS) {
      if (keys.has(col)) await pushRecordCollection(col);
    }
    for (const unit of DOC_UNITS) {
      if (unit.triggers.some((t) => keys.has(t))) await pushDocUnit(unit);
    }
    await patchSyncState({ lastSyncedAt: Date.now(), lastError: '' });
  } catch (error) {
    // Re-arm so a transient failure retries on the next change.
    for (const k of keys) dirty.add(k);
    await patchSyncState({ lastError: String(error) });
  }
}

async function pushRecordCollection(col: RecordCollection): Promise<void> {
  if (!backend) return;
  // Delete tombstoned docs from Firestore (best-effort cleanup; the synced
  // tombstone map is what actually propagates the deletion to other devices).
  const dead = pendingDeletes[col];
  if (dead && dead.size > 0) {
    const ids = [...dead];
    dead.clear();
    await backend.deleteRecords(col, ids);
    for (const id of ids) pushedVersions.delete(recKey(col, id));
  }
  const local = (await getLocal(col))[col] as unknown as SyncRecord[];
  const changed = local.filter((r) => pushedVersions.get(recKey(col, r.id)) !== (r.updatedAt ?? 0));
  if (changed.length === 0) return;
  await backend.pushRecords(col, changed);
  for (const r of changed) pushedVersions.set(recKey(col, r.id), r.updatedAt ?? 0);
}

async function pushDocUnit(unit: DocUnit): Promise<void> {
  if (!backend) return;
  const local = await getLocal(...unit.triggers);
  const payload = unit.read(local as unknown as LocalSchema);
  const hash = JSON.stringify(payload);
  if (pushedDocs.get(unit.path) === hash) return;
  await backend.pushDoc(unit.path, payload);
  pushedDocs.set(unit.path, hash);
}

async function applyRemoteRecords(col: RecordCollection, remote: SyncRecord[]): Promise<void> {
  if (!running) return;
  const local = (await getLocal(col))[col] as unknown as SyncRecord[];
  const { tombstones } = await getLocal('tombstones');
  // Never resurrect a locally-deleted record that another device still has.
  const merged = mergeRecordCollection(local, remote).filter(
    (r) => !(tombstoneKey(col, r.id) in tombstones),
  );
  // Mark merged versions as already-synced so the write we're about to make
  // does not echo back out through the push path.
  for (const r of merged) pushedVersions.set(recKey(col, r.id), r.updatedAt ?? 0);
  await setLocal({ [col]: merged } as unknown as Partial<LocalSchema>);
}

async function applyRemoteDoc(unit: DocUnit, data: unknown): Promise<void> {
  if (!running || data == null) return;
  const mergedHash = await unit.apply(data);
  pushedDocs.set(unit.path, mergedHash);
}
