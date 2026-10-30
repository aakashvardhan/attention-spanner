import { DEFAULT_FOCUS_BLOCKLIST } from './constants';
import { DEFAULT_TOPICS } from './topics';
import type {
  AiCacheEntry,
  Annotation,
  AnyProgress,
  DayActivity,
  Deck,
  Dump,
  FeedItem,
  FocusSession,
  HighlightRole,
  LockedDump,
  Paper,
  Provocation,
  Settings,
  Vault,
} from './types';
import type { TranscriptSegment } from './youtubeCaptions';

export interface LocalSchema {
  schemaVersion: number;
  provocations: Provocation[];
  feeds: string[];
  readItems: string[];
  cachedItems: FeedItem[];
  cacheTimestamp: number;
  settings: Settings;
  readingProgress: Record<string, AnyProgress>;
  focusSession: FocusSession | null;
  decks: Deck[];
  /** Research papers, grouped into decks */
  papers: Paper[];
  /** Reader highlights & sticky notes (PDFs and articles), keyed by docKey */
  annotations: Annotation[];
  /** Generated text keyed 'task:hash' (llm/cache.ts); a cache, so loss is harmless */
  aiCache: Record<string, AiCacheEntry>;
  /** int8 embeddings keyed by FeedItem id or annotation id (llm/vectors.ts) */
  aiVectors: Record<string, string>;
  /** Laya's reading of each highlight, keyed by annotation id; a cache. Nothing writes it since llm/matrix.ts was deleted */
  layaRoles: Record<string, HighlightRole>;
  /** Per local day 'YYYY-MM-DD': papers read, focus sessions finished (shared/activity.ts) */
  activity: Record<string, DayActivity>;
  /**
   * Brain dumps waiting for first-time vault setup, in the clear until then.
   * Never rename this to a key in V22_DEAD_KEYS ('notes', 'parkingLot'...):
   * that sweep re-runs on every schema bump and would delete them.
   */
  dumps: Dump[];
  /** The dump vault; null until the first dump's setup */
  vault: Vault | null;
  /** Sealed dumps, newest first (shared/vault.ts) */
  lockedDumps: LockedDump[];
}

export interface SessionSchema {
  trackedTabs: Record<number, { normalizedUrl: string; injectedAt: number }>;
  pendingResume: Record<
    number,
    { scrollY: number; percent: number } | { positionSeconds: number }
  >;
  /** PDF URLs the user sent to Chrome's native viewer — don't re-intercept this session */
  pdfNativeBypass: string[];
  /**
   * YouTube transcripts behind the Continue row's video summary, keyed by videoId.
   * Session-scoped because a transcript is only interesting while the video is
   * on screen — caching them to disk would grow without a bound anyone watches.
   */
  videoTranscripts: Record<string, TranscriptSegment[]>;
  /** Gemini's topic answers, keyed by normalized URL or videoId, so an item is asked once. */
  topicVerdicts: Record<string, boolean>;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  readerNight: false,
  readerFocusLine: false,
  refreshInterval: 30,
  notificationsEnabled: true,
  focusBlocklist: DEFAULT_FOCUS_BLOCKLIST,
  focusMinutes: 50,
  breakMinutes: 10,
  focusSound: true,
  semanticScholarApiKey: '',
  ollamaUrl: 'http://localhost:11434',
  ollamaChatModel: '',
  ollamaEmbedModel: 'nomic-embed-text',
  cloudMode: 'all',
  claudeKey: '',
  layaUrl: '',
  mutedTopics: [],
  trackTopics: [...DEFAULT_TOPICS],
  geminiTopicKey: '',
};

export const DEFAULTS: LocalSchema = {
  schemaVersion: 26,
  provocations: [],
  feeds: [],
  readItems: [],
  cachedItems: [],
  cacheTimestamp: 0,
  settings: DEFAULT_SETTINGS,
  readingProgress: {},
  focusSession: null,
  decks: [],
  papers: [],
  annotations: [],
  // Additive, so no migration: getLocal and useStorageValue fall back to
  // DEFAULTS for a key that was never written, and getSettings spreads over
  // DEFAULT_SETTINGS. migrate() is for repairing data a live feature reads, not
  // for seeding keys — see the note above it.
  aiCache: {},
  aiVectors: {},
  layaRoles: {},
  activity: {},
  dumps: [],
  vault: null,
  lockedDumps: [],
};

export const SESSION_DEFAULTS: SessionSchema = {
  trackedTabs: {},
  pendingResume: {},
  pdfNativeBypass: [],
  videoTranscripts: {},
  topicVerdicts: {},
};

export async function getLocal<K extends keyof LocalSchema>(
  ...keys: K[]
): Promise<Pick<LocalSchema, K>> {
  const stored = await chrome.storage.local.get(keys);
  const out = {} as Pick<LocalSchema, K>;
  for (const key of keys) {
    out[key] = (stored[key] as LocalSchema[K] | undefined) ?? structuredClone(DEFAULTS[key]);
  }
  return out;
}

export async function setLocal(items: Partial<LocalSchema>): Promise<void> {
  await chrome.storage.local.set(items);
}

/**
 * Dump writes read a list, seal, then write it back. Two tabs doing that at
 * once would drop one entry, so they take turns through a Web Lock, which
 * every page of the extension shares.
 */
export function withDumpLock<T>(fn: () => Promise<T>): Promise<T> {
  return navigator.locks.request('dumps', fn);
}

export async function getSession<K extends keyof SessionSchema>(
  ...keys: K[]
): Promise<Pick<SessionSchema, K>> {
  const stored = await chrome.storage.session.get(keys);
  const out = {} as Pick<SessionSchema, K>;
  for (const key of keys) {
    out[key] = (stored[key] as SessionSchema[K] | undefined) ?? structuredClone(SESSION_DEFAULTS[key]);
  }
  return out;
}

export async function setSession(items: Partial<SessionSchema>): Promise<void> {
  await chrome.storage.session.set(items);
}

export async function getSettings(): Promise<Settings> {
  const { settings } = await getLocal('settings');
  // Spread over defaults so settings added in later versions pick up their default
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const settings = { ...(await getSettings()), ...patch };
  await setLocal({ settings });
  return settings;
}

/**
 * Schema history, as it still exists in code.
 *
 * Most of the chain has been collapsed. A migration whose only job was to seed
 * a key that a later version removes is deleted rather than stubbed — v22's
 * sweep lands such a profile in exactly the same state, and a branch that
 * writes a key nothing reads is just a slower way to arrive there. What
 * survives below is only the migrations that repair data a LIVE feature reads.
 *
 * v4 → v5 (papers): decks became typed. Backfill Deck.kind — a deck holding
 * papers is 'papers', anything else keeps the historical 'flashcards'.
 * v5 → v6: backfill `updatedAt` from `createdAt` on decks, so every
 * record carries a stable timestamp.
 * v6 → v7 (one reader): the reader gained a second document kind, so
 * `pdfAnnotations` becomes `annotations` with its page/rect fields wrapped in
 * a discriminated `anchor` (see types.AnnotationAnchor).
 * v10 → v11: feed item ids were truncated to 24 bytes of input, so every
 * article on a site shared one and the stored read state marked whole sites
 * read. The old ids are unmappable, so read state starts over.
 * v11 → v12 (reader progress): repair reading entries that took the reader
 * page's own title and URL, which left Continue rows called "Reader" linking to
 * the extension instead of the article. See v12ReadingProgress.
 * v14 → v15 rewrote a stored skin 'auto' to 'brave'. Skins were retired in the
 * Edition redesign (2026-10), so the step is gone; the version number stays.
 * v21 → v22 (complement Notion, don't duplicate it): notes, tasks, meeting
 * notes, job tracking, the assistant, Google, and the habit layer are all
 * gone. Their keys and settings are swept in one cumulative pass that also
 * carries what v13, v20 and v21 retired — see V22_DEAD_KEYS.
 * v22 → v23: the daily focus line and the unreachable Pomodoro mode went.
 * Their key and setting join the same cumulative lists, and the sweep re-runs
 * — removing an absent key is a no-op, so re-running v22's entries is free.
 * v23 → v24: brain dumps lose their task fields and sorted points (v24Dumps).
 * v24 → v25 (minimal revamp): bookmarks, weather, AI stats, Flowtunes, Gemini,
 * hyperfocus and reading nudges went. Their keys and settings join the same
 * cumulative lists, so the sweep re-runs; progress records and papers drop
 * their `nudge` state (v25Progress, v25StripNudge).
 * v25 → v26: progress entries for non-http(s) pages (the extension's own new
 * tab was recorded as "Focus workspace") are removed (v26Progress).
 */
export async function migrate(): Promise<void> {
  const { schemaVersion } = await chrome.storage.local.get('schemaVersion');
  const version = (schemaVersion as number | undefined) ?? 0;
  // Session storage outlives an extension update, so retired keys go on every
  // install/update, before the early return. Removing an absent key is a no-op.
  await chrome.storage.session.remove(['hyperfocus', 'driftChecked', 'lastGlobalNudgeAt']);
  // Must match the version written at the end: this guard was left at 10 when
  // v11 landed, which stranded anyone already on 10 — they never ran v11.
  if (version >= 26) return;

  // Only branches that repair data a SURVIVING feature reads are kept. Every
  // migration that merely seeded a key now removed — the calendar defaults, the
  // feature packs, the dashboard presets, the gamification counters — is gone
  // rather than stubbed, because v22's sweep below lands a profile in exactly
  // the same state. This is the pattern v21 already used for v17's gate key.
  if (version < 5) await migrateToV5();
  if (version < 6) await migrateToV6();
  if (version < 7) await migrateToV7();
  // v10 → v11: feed item ids were truncated to 24 bytes of input, so every
  // article on a site shared one — the stored read state marked whole sites
  // read. The ids are unmappable to the new scheme, and the old values are
  // worse than none, so start over. Everything shows unread once.
  if (version < 11) await chrome.storage.local.set({ readItems: [] });
  if (version < 12) await migrateToV12();
  await migrateToV22();
  if (version < 24) {
    const { dumps } = await chrome.storage.local.get('dumps');
    await chrome.storage.local.set({ dumps: v24Dumps((dumps as unknown[] | undefined) ?? []) });
  }

  if (version < 25) {
    // Read fresh: v12 and v24 above write these keys themselves.
    const { readingProgress, papers } = await chrome.storage.local.get(['readingProgress', 'papers']);
    const progress = v25Progress(readingProgress as Record<string, unknown> | undefined);
    if (progress) await chrome.storage.local.set({ readingProgress: progress });
    if (Array.isArray(papers) && papers.some((p) => p && typeof p === 'object' && 'nudge' in p)) {
      await chrome.storage.local.set({ papers: papers.map((p) => (p && typeof p === 'object' ? v25StripNudge(p) : p)) });
    }
  }

  if (version < 26) {
    const { readingProgress } = await chrome.storage.local.get('readingProgress');
    const progress = v26Progress(readingProgress as Record<string, unknown> | undefined);
    if (progress) await chrome.storage.local.set({ readingProgress: progress });
  }

  await chrome.storage.local.set({ schemaVersion: 26 });
}

/** v25 → v26: drops progress entries whose url isn't http(s). Null when nothing changed. */
export function v26Progress(map: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!map || typeof map !== 'object') return null;
  const kept = Object.entries(map).filter(([, e]) => {
    const url = e && typeof e === 'object' ? (e as { url?: unknown }).url : undefined;
    return typeof url === 'string' && /^https?:/.test(url);
  });
  return kept.length === Object.keys(map).length ? null : Object.fromEntries(kept);
}

/** v24 → v25: reading nudges are cut; a record keeps everything but its `nudge`. */
export function v25StripNudge<T extends object>(record: T): Omit<T, 'nudge'> {
  const { nudge: _, ...rest } = record as T & { nudge?: unknown };
  return rest;
}

/** v25StripNudge over every progress entry. Null when nothing changed, so a clean profile is not rewritten. */
export function v25Progress(map: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!map || typeof map !== 'object') return null;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(map)) {
    const has = !!entry && typeof entry === 'object' && 'nudge' in entry;
    next[key] = has ? v25StripNudge(entry) : entry;
    changed ||= has;
  }
  return changed ? next : null;
}

/**
 * v23 → v24: the brain dump stopped sorting and stepping. Points it sorted a
 * dump into are dropped; each original dump keeps only its words, which get
 * sealed into the vault at first-time setup.
 */
export function v24Dumps(list: readonly unknown[]): Dump[] {
  return (list as Partial<Dump & { parentId: string }>[])
    .filter((d) => !d.parentId && typeof d.text === 'string')
    .map((d) => ({ id: d.id ? String(d.id) : crypto.randomUUID(), text: d.text!, createdAt: Number(d.createdAt) || 0 }));
}

/**
 * Every key belonging to a feature that has been cut. Removing them is not
 * cosmetic: `getLocal` merges DEFAULTS over what is stored, so an orphaned key
 * sits in quota forever, and `recordings`-sized values are not small. Settings
 * need an explicit delete too — patchSettings writes the whole merged object,
 * so a dropped field stays on disk for anyone who ever opened Settings, and
 * changing DEFAULT_SETTINGS alone never reaches them.
 *
 * This list is cumulative: it carries every key retired by v13, v20 and v21 as
 * well, so a profile jumping straight from an old version lands clean without
 * those migrations having to run.
 */
export const V22_DEAD_KEYS = [
  // Notes, brain dump, and the encrypted vault (v13's Notion keys ride along)
  'notes',
  'notesVault',
  'notionQueue',
  'notionStatus',
  'meetingNotes',
  'dailyBrainDumpGate',
  // Tasks and quick capture
  'tasks',
  // Job board
  'jobs',
  'jobSources',
  'jobProfile',
  'jobRuns',
  // Assistant, journal, automations, weekly review
  'assistantMemory',
  'assistantSkills',
  'assistantAutomations',
  'assistantJournal',
  'assistantProfile',
  'assistantBriefing',
  'weekReviews',
  'pdfOutlineCache',
  // Recordings and live transcription
  'recordings',
  // Google
  'calendar',
  'gmail',
  // Streaks, gamification, prime time
  'streaks',
  'gamification',
  'gym',
  'warmup',
  // Time pill
  'siteTime',
  // Attention relay and feature packs
  'activeIntent',
  'enabledPacks',
  'parkingLot',
  // Citation graph and its reverse index
  'docCitations',
  'graphCitations',
  'graphNodes',
  'graphView',
  'graphVisible',
  // Cut before this pass, swept here so one list is the whole truth
  'sync',
  'tombstones',
  'flashCards',
  'flashNotes',
  'srsDaily',
  'alphaxiv',
  'xBookmarks',
  'xBookmarksLastSyncedAt',
  // v23: the new tab's daily focus line
  'focusOfDay',
  // v25: minimal revamp
  'weather',
  'bookmarks',
  'bookmarkGroups',
  'aiStats',
];

export const V22_DEAD_SETTINGS = [
  // Assistant and its providers
  'assistantEnabled',
  'geminiApiKey',
  'anthropicApiKey',
  'cloudProvider',
  'assistantReactEnabled',
  'assistantVoiceEnabled',
  'assistantTtsVoice',
  'assistantVisionEnabled',
  'assistantLiveEnabled',
  'assistantMonitorEnabled',
  'assistantWakeWordEnabled',
  'monitorEveningTime',
  'ollamaBaseUrl',
  'ollamaModel',
  // Tasks, sprints, streak goal
  'taskReminderIntervalMinutes',
  'sprintMinutes',
  'dailyGoalMinutes',
  // Google
  'gmailTriageTime',
  'focusCalendarBlockEnabled',
  // Time pill
  'timePillHosts',
  // v25: minimal revamp
  'hyperfocusEnabled',
  'focusMusicEnabled',
  'geminiKey',
  'nudgesEnabled',
  // Retired earlier; listed so one sweep is the whole truth
  'dashboardMode',
  'dashColumns',
  'dashCardOrder',
  'dashHiddenCards',
  'dashFullWidthCards',
  'gymWeeklyTarget',
  'gymReminderTime',
  'notesPasscodeHash',
  'questArticlesPerWeek',
  'questSprintsPerWeek',
  'questVideosPerWeek',
  'questFocusPerWeek',
  // v23: Pomodoro could never be started, so its break length was never read
  'focusBreakMinutes',
  // v25: minimal revamp
  'displayName',
  'weatherLocation',
  'ambientMotion',
];

/** Pure core of v22's settings half, so the delete rule is testable. */
export function v22StripSettings(
  settings: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!settings || typeof settings !== 'object') return null;
  const next = { ...settings };
  for (const key of V22_DEAD_SETTINGS) delete next[key];
  return next;
}

async function migrateToV22(): Promise<void> {
  await chrome.storage.local.remove(V22_DEAD_KEYS);
  // Read fresh rather than from a snapshot taken at the top of migrate(): the
  // earlier branches write settings themselves.
  const { settings } = await chrome.storage.local.get('settings');
  const next = v22StripSettings(settings as Record<string, unknown> | undefined);
  if (next) await chrome.storage.local.set({ settings: next });
}

/** v4 → v5: decks predate `kind`; papers live in them, so default to papers. */
async function migrateToV5(): Promise<void> {
  const { decks, papers } = await chrome.storage.local.get(['decks', 'papers']);
  const deckList = (decks as Deck[] | undefined) ?? [];
  if (!deckList.length) return;
  const paperList = (papers as { deckId: string }[] | undefined) ?? [];
  for (const deck of deckList) {
    if (deck.kind) continue;
    deck.kind = paperList.some((p) => p.deckId === deck.id) ? 'papers' : 'flashcards';
  }
  await chrome.storage.local.set({ decks: deckList });
}

/** v5 → v6: backfill `updatedAt` from `createdAt` on the collections that survive. */
async function migrateToV6(): Promise<void> {
  const keys = ['decks'] as const;
  const collections = await chrome.storage.local.get([...keys]);
  const patch: Record<string, unknown> = {};
  for (const key of keys) {
    const list = collections[key] as { createdAt?: number; updatedAt?: number }[] | undefined;
    if (!list?.length) continue;
    patch[key] = list.map((r) => (r.updatedAt == null ? { ...r, updatedAt: r.createdAt ?? 0 } : r));
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

/**
 * Pure core of v6 → v7's surviving half. Annotations grew an anchor union when
 * the reader learned to read articles; every record from before then is a PDF
 * one. Returns null when there is nothing to convert.
 */
export function v7Annotations(
  legacy: unknown,
): Record<string, unknown>[] | null {
  const list = legacy as
    | ({ page: number; rects: unknown[]; x: number; y: number; pdfUrl: string } & Record<
        string,
        unknown
      >)[]
    | undefined;
  if (!list?.length) return null;
  return list.map(({ page, rects, x, y, pdfUrl, ...rest }) => ({
    ...rest,
    docUrl: pdfUrl,
    anchor: { kind: 'pdf' as const, page, rects, x, y },
  }));
}

async function migrateToV7(): Promise<void> {
  const { pdfAnnotations } = await chrome.storage.local.get('pdfAnnotations');
  const converted = v7Annotations(pdfAnnotations);
  if (converted) await chrome.storage.local.set({ annotations: converted });
  if (pdfAnnotations !== undefined) await chrome.storage.local.remove('pdfAnnotations');
}

/** The document a reader-page URL was showing, or null if this isn't one. */
function readerDocUrl(url: string): string | null {
  if (!url.startsWith('chrome-extension://')) return null;
  try {
    const params = new URL(url).searchParams;
    return params.get('article') ?? params.get('src');
  } catch {
    return null;
  }
}

/**
 * Pure core of v11 → v12. Progress reported from the reader used to be stamped
 * with the reader tab's own title and URL, so a Continue row could read
 * "Reader" and open the extension page instead of the article. The real URL
 * survives inside the reader link's ?article=/?src= param; the title doesn't,
 * so it's cleared and refills the next time the article is opened. Returns null
 * when nothing was corrupted, so an untouched profile isn't rewritten.
 */
export function v12ReadingProgress(
  progress: Record<string, AnyProgress>,
): Record<string, AnyProgress> | null {
  const repaired: Record<string, AnyProgress> = {};
  let changed = false;
  for (const [key, entry] of Object.entries(progress)) {
    const docUrl = entry.kind === 'video' ? null : readerDocUrl(entry.url);
    if (!docUrl) {
      repaired[key] = entry;
      continue;
    }
    repaired[key] = { ...entry, url: docUrl, title: entry.title === 'Reader' ? '' : entry.title };
    changed = true;
  }
  return changed ? repaired : null;
}

async function migrateToV12(): Promise<void> {
  const { readingProgress } = await chrome.storage.local.get('readingProgress');
  if (!readingProgress) return;
  const repaired = v12ReadingProgress(readingProgress as Record<string, AnyProgress>);
  if (repaired) await chrome.storage.local.set({ readingProgress: repaired });
}
