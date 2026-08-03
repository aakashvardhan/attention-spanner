import type { AssistantTurn } from './ai/assistantTypes';
import type { AiOutlineItem } from './ai/pdfOutline';
import { CALENDAR_DEFAULTS, type CalendarState } from './calendar';
import { DEFAULT_FOCUS_BLOCKLIST } from './constants';
import { connectedAccounts, GMAIL_DEFAULTS, type GmailState } from './gmail';
import type { CitationExpansion } from './citations';
import type { DocCitations } from './docCitations';
import { gateStateForDate } from './dailyBrainDump';
import { idleLiveSession, type LiveSession } from './live';
import type { NotesVault } from './notesVault';
import { hoursFromTimestamps } from './primeTime';
import type { Recording, RecordingSource } from './recordings';
import type {
  Annotation,
  ActiveIntent,
  AnyProgress,
  AssistantAutomation,
  AssistantFact,
  AssistantSkill,
  BookmarkGroup,
  BookmarkLink,
  BrainDumpNote,
  DailyBrainDumpGateState,
  Deck,
  FeedItem,
  FocusSession,
  Gamification,
  JournalDay,
  LifetimeCounters,
  Paper,
  Settings,
  Streaks,
  Task,
  WeekReview,
  EnabledPack,
} from './types';

export interface LocalSchema {
  schemaVersion: number;
  feeds: string[];
  readItems: string[];
  cachedItems: FeedItem[];
  cacheTimestamp: number;
  settings: Settings;
  tasks: Task[];
  notes: BrainDumpNote[];
  dailyBrainDumpGate: DailyBrainDumpGateState;
  enabledPacks: EnabledPack[];
  activeIntent: ActiveIntent | null;
  readingProgress: Record<string, AnyProgress>;
  streaks: Streaks;
  gamification: Gamification;
  focusSession: FocusSession | null;
  bookmarks: BookmarkLink[];
  bookmarkGroups: BookmarkGroup[];
  decks: Deck[];
  /** Research papers, grouped into decks (shared with flashcards) */
  papers: Paper[];
  /** Reader highlights & sticky notes (PDFs and articles), keyed by docKey.
   *  Local-only; shaped for future per-record sync. */
  annotations: Annotation[];
  /**
   * Transcribed lectures, meetings and videos. Device-local by design and
   * deliberately absent from RECORD_COLLECTIONS: a transcript of a meeting is
   * the most sensitive thing this extension holds, so it stays on the machine
   * that captured it rather than reaching Firestore or the iOS app.
   */
  recordings: Recording[];
  /** Time-pill totals for the one local day in `date`; hosts keyed by configured domain */
  siteTime: { date: string; hosts: Record<string, number> };
  /** Facts the user asked the assistant to remember. Device-local — not synced (v1). */
  assistantMemory: AssistantFact[];
  /** User-written instruction docs the assistant consults. Device-local — not synced (v1). */
  assistantSkills: AssistantSkill[];
  /** Scheduled agent runs (discovery/triage on alarms). Device-local. */
  assistantAutomations: AssistantAutomation[];
  /**
   * What happened, day by day — plans, digests, applied actions, close-outs.
   * The assistant's episodic memory: `assistantThread` is session-scoped and
   * evaporates with the browser, so without this nothing survives a restart
   * except the 50 remembered facts. Device-local, like the rest of the
   * assistant's state. Pruned to JOURNAL_MAX_DAYS.
   */
  assistantJournal: Record<string, JournalDay>;
  /**
   * The user's own "about me" — goals, working style, constraints. Hand-written
   * in Settings and never model-writable: an assistant that can overwrite your
   * identity doc is a bad trade. Prepended ahead of the context char cap so it
   * can never be truncated away.
   */
  assistantProfile: { text: string; updatedAt: number };
  /** Weekly reckonings keyed by weekKey(). Device-local. */
  weekReviews: Record<string, WeekReview>;
  /** Google Calendar connection + cached agenda window. Device-local — never synced. */
  calendar: CalendarState;
  /**
   * Gmail connections (one per mailbox) plus the last triage run. Device-local
   * and deliberately absent from RECORD_COLLECTIONS — these are OAuth tokens
   * for the user's mail, which must never reach Firestore or the iOS app.
   */
  gmail: GmailState;
  /**
   * Brain-dump encryption keys; null = encryption off. Deliberately absent from
   * RECORD_COLLECTIONS and DOC_UNITS so it can never reach Firestore: notes sync
   * as ciphertext, and the key that opens them stays on this device.
   */
  notesVault: NotesVault | null;
  /**
   * Reverse citation index, keyed by document. Built from bibliographies the
   * reader already parses, so it needs no network and works offline. Out of
   * Per-device: a projection of what this device has opened, cheap to rebuild.
   */
  docCitations: Record<string, DocCitations>;
  /**
   * Citation expansions, keyed by the library paper they hang off. The `graph`
   * in the name is a leftover — the knowledge graph is gone and this is now the
   * reader's Related panel cache. Per-device: cheap to rebuild, wrong to merge.
   */
  graphCitations: Record<string, CitationExpansion>;
  /**
   * Content-addressed AI outlines for PDFs. Device-local: the source passages
   * can be rebuilt from the PDF and should neither consume sync quota nor
   * trigger another model request when the same paper is reopened.
   */
  pdfOutlineCache: Record<
    string,
    { items: AiOutlineItem[]; createdAt: number; lastAccessedAt: number }
  >;
}

/** Per-device cloud-sync bookkeeping (see src/background/sync.ts). */
export interface SessionSchema {
  trackedTabs: Record<number, { normalizedUrl: string; injectedAt: number }>;
  pendingResume: Record<
    number,
    { scrollY: number; percent: number } | { positionSeconds: number }
  >;
  activeSprint: { startedAt: number; durationMin: number } | null;
  lastGlobalNudgeAt: number;
  /** Unbroken reading/watching run for the hyperfocus guardrail */
  hyperfocus: { unbrokenSeconds: number; lastDeltaAt: number; notifiedAtSeconds: number };
  /** Assistant conversation — session-scoped by design (private, resets with the browser) */
  assistantThread: AssistantTurn[];
  /** Calendar events already notified by the monitor (session lifetime = dedupe lifetime) */
  monitorNotifiedEventIds: string[];
  /** Command captured by the wake-word listener, handed off to the dashboard to run */
  assistantPendingInput: string;
  /** Assistant response cache, shared across contexts (see src/shared/ai/cache.ts) */
  assistantCache: Record<string, { v: unknown; exp: number; tag: string }>;
  /** Automations waiting for an on-device run (no cloud key) — drained on dashboard open */
  pendingAutomationRuns: string[];
  /** PDF URLs the user sent to Chrome's native viewer — don't re-intercept this session */
  pdfNativeBypass: string[];
  /**
   * The capture in flight, if any. Session-scoped because a recording cannot
   * outlive the browser anyway — what survives a restart is the transcript in
   * `recordings`, which startup reconciliation settles (see reconcileOrphans).
   */
  activeRecording: {
    id: string;
    startedAt: number;
    source: RecordingSource;
    /** Rotation counter — the next segment's index, hence its wall-clock offset */
    segmentIndex: number;
  } | null;
  /**
   * Which features currently need the single offscreen document alive. Held
   * here rather than in a module variable because the service worker is torn
   * down after ~30s idle while the document keeps running — a module-level set
   * would come back empty and close a document mid-recording.
   */
  offscreenHolders: string[];
  /**
   * Live mode: suggested answers for the recording in flight. Session-scoped
   * for the same reason activeRecording is, and additionally because these are
   * coaching for a moment rather than an artifact — the durable half of a live
   * recording is its transcript, which lands in `recordings` as usual.
   */
  liveSession: LiveSession;
  /**
   * The unwrapped notes-vault private key as PKCS8 hex; '' = locked. Session
   * storage because that is exactly the unlock lifetime (cleared when the
   * browser closes) and because both extension pages and the service worker can
   * read it. A CryptoKey is not structured-cloneable, hence the hex.
   */
  notesPrivateKey: string;
  /**
   * What the graph page is showing. Session-scoped because a view filter is not
   * a preference — it belongs to this sitting, and starting tomorrow with
   * yesterday's topic still applied would be its own small bug.
   *
   * The page is a subscriber here rather than the owner: the toolbar chips and
   * the assistant's focus_graph tool write through the same key, so there is
   * one source of truth instead of tool state merged over React state.
   */
  /** What the graph is currently drawing — published by the page, read by the
   *  assistant. See shared/ai/graphDigest.ts for why it flows that way. */
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  /* Not 'auto': auto means "match the host browser", which in Chrome is the
     blue skin. The Brave orange is the wanted look regardless of host. */
  skin: 'brave',
  refreshInterval: 30,
  notificationsEnabled: true,
  nudgesEnabled: false,
  taskReminderIntervalMinutes: 0,
  sprintMinutes: 5,
  dailyGoalMinutes: 5,
  gymWeeklyTarget: 3,
  gymReminderTime: '',
  hyperfocusEnabled: true,
  timePillHosts: [],
  focusBlocklist: DEFAULT_FOCUS_BLOCKLIST,
  focusMinutes: 50,
  focusBreakMinutes: 10,
  focusMusicEnabled: false,
  dashboardMode: 'focused',
  semanticScholarApiKey: '',
  assistantEnabled: false,
  geminiApiKey: '',
  anthropicApiKey: '',
  cloudProvider: 'gemini',
  assistantReactEnabled: true,
  assistantVoiceEnabled: false,
  assistantTtsVoice: '',
  assistantVisionEnabled: true,
  assistantLiveEnabled: false,
  focusCalendarBlockEnabled: false,
  assistantMonitorEnabled: false,
  monitorEveningTime: '19:00',
  gmailTriageTime: '08:30',
};

export const DEFAULTS: LocalSchema = {
  schemaVersion: 20,
  feeds: [],
  readItems: [],
  cachedItems: [],
  cacheTimestamp: 0,
  settings: DEFAULT_SETTINGS,
  tasks: [],
  notes: [],
  dailyBrainDumpGate: { date: '', completedAt: null, noteId: null },
  enabledPacks: [],
  activeIntent: null,
  readingProgress: {},
  streaks: { currentStreak: 0, longestStreak: 0, lastQualifiedDate: '', daily: {}, freezeTokens: 0 },
  gamification: {
    badges: {},
    counters: {
      articlesFinished: 0,
      videosFinished: 0,
      sprints: 0,
      tasksCompleted: 0,
      brainDumps: 0,
      focusBlocks: 0,
      freezesEarned: 0,
    },
  },
  focusSession: null,
  bookmarks: [],
  bookmarkGroups: [],
  decks: [],
  papers: [],
  annotations: [],
  recordings: [],
  siteTime: { date: '', hosts: {} },
  assistantMemory: [],
  assistantSkills: [],
  assistantAutomations: [],
  assistantJournal: {},
  assistantProfile: { text: '', updatedAt: 0 },
  weekReviews: {},
  calendar: CALENDAR_DEFAULTS,
  gmail: GMAIL_DEFAULTS,
  notesVault: null,
  docCitations: {},
  graphCitations: {},
  pdfOutlineCache: {},
};

export const SESSION_DEFAULTS: SessionSchema = {
  trackedTabs: {},
  pendingResume: {},
  activeSprint: null,
  lastGlobalNudgeAt: 0,
  hyperfocus: { unbrokenSeconds: 0, lastDeltaAt: 0, notifiedAtSeconds: 0 },
  assistantThread: [],
  monitorNotifiedEventIds: [],
  assistantPendingInput: '',
  assistantCache: {},
  pendingAutomationRuns: [],
  pdfNativeBypass: [],
  activeRecording: null,
  offscreenHolders: [],
  liveSession: idleLiveSession(),
  notesPrivateKey: '',
};

/* Offscreen documents get chrome.runtime but not chrome.storage — route their
   reads/writes through the service worker instead. Feature-detected so pages,
   the worker, and vitest (no chrome at all) keep the direct path. */
const hasStorageApi = typeof chrome !== 'undefined' && !!chrome.storage;

async function proxyGet(area: 'local' | 'session', keys: string[]): Promise<Record<string, unknown>> {
  return chrome.runtime.sendMessage({ type: 'PROXY_STORAGE', area, op: 'get', keys });
}

async function proxySet(area: 'local' | 'session', items: Record<string, unknown>): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'PROXY_STORAGE', area, op: 'set', items });
}

export async function getLocal<K extends keyof LocalSchema>(
  ...keys: K[]
): Promise<Pick<LocalSchema, K>> {
  const stored = hasStorageApi ? await chrome.storage.local.get(keys) : await proxyGet('local', keys);
  const out = {} as Pick<LocalSchema, K>;
  for (const key of keys) {
    out[key] = (stored[key] as LocalSchema[K] | undefined) ?? structuredClone(DEFAULTS[key]);
  }
  return out;
}

export async function setLocal(items: Partial<LocalSchema>): Promise<void> {
  if (hasStorageApi) await chrome.storage.local.set(items);
  else await proxySet('local', items);
}

export async function getSession<K extends keyof SessionSchema>(
  ...keys: K[]
): Promise<Pick<SessionSchema, K>> {
  const stored = hasStorageApi
    ? await chrome.storage.session.get(keys)
    : await proxyGet('session', keys);
  const out = {} as Pick<SessionSchema, K>;
  for (const key of keys) {
    out[key] = (stored[key] as SessionSchema[K] | undefined) ?? structuredClone(SESSION_DEFAULTS[key]);
  }
  return out;
}

export async function setSession(items: Partial<SessionSchema>): Promise<void> {
  if (hasStorageApi) await chrome.storage.session.set(items);
  else await proxySet('session', items);
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
 * v0 (legacy vanilla extension) → v1: fold the bare `refreshInterval` key into
 * the settings object. feeds/readItems/cachedItems carry over unchanged.
 * v1 → v2 (Phase 6): backfill counters.videosFinished. Old DayStats entries
 * keep missing videosFinished — read sites use `?? 0` instead of a rewrite.
 * v2 → v3 (Phase 7): backfill counters.focusBlocks (DayStats.focusBlocks
 * likewise stays optional, read with `?? 0`).
 * v3 → v4 (Phase 13): backfill counters.cardsReviewed. The flashcards
 * collections themselves need no migration — getLocal falls back to DEFAULTS.
 * v4 → v5 (papers): decks became typed. Backfill Deck.kind — a deck with
 * cards/notes is 'flashcards', one with only papers is 'papers', empty decks
 * default to 'flashcards' (their historical purpose).
 * v5 → v6 (cloud sync): backfill SyncMeta.updatedAt on records that lack it
 * (tasks, notes, decks, flashCards, bookmarks, bookmarkGroups) from createdAt,
 * so last-write-wins merge has a stable timestamp. FlashNote/Paper already
 * carry updatedAt; deletedAt stays unset (== null) until a real delete.
 * v6 → v7 (one reward currency + one reader): the XP economy, level curve and
 * weekly quest are gone, so drop `gamification.xp` / `lastQuestCelebratedWeek`
 * and the four quest* settings. `counters.chestsOpened` becomes
 * `freezesEarned` (chests now drop streak freezes), `Task.chest.bonusXp`
 * becomes a bare `rolled` marker, and the merged 'progress' card leaves
 * dashCardOrder. The reader also gained a second document kind, so
 * `pdfAnnotations` becomes `annotations` with its page/rect fields wrapped in
 * a discriminated `anchor` (see types.AnnotationAnchor).
 * v7 → v8 (prime time): seed `DayStats.hours` from the timestamps already kept
 * on tasks, notes, bookmarks, annotations, flash notes, papers and reading
 * progress, so the punchcard opens with real history. `hours` itself stays
 * optional — days with neither evidence nor live credit simply lack it.
 * v8 → v9 (encrypted notes): the passcode became a real key rather than a
 * render gate, so `settings.notesPasscodeHash` goes away — the vault in
 * `notesVault` authenticates by unwrapping, and nothing derived from the
 * passcode is stored. Existing notes stay plain text until the user turns
 * encryption on in Options, which seals them in place.
 * v9 → v10 (bring-your-own calendar client): Google Calendar stopped using
 * chrome.identity.getAuthToken, so the old connection is a token Chrome holds
 * and this extension can no longer ask for. Reset the slice — the user pastes
 * their own OAuth client in Settings and reconnects.
 * v11 → v12 (reader progress): repair reading entries that took the reader
 * page's own title and URL, which left Continue rows called "Reader" linking to
 * the extension instead of the article. See v12ReadingProgress.
 * v12 → v13 (Notion removed): the one-way push and the meeting-notes pull are
 * gone, so drop the notion* settings (one of which held an integration token),
 * the push queue/status, and the meeting-notes cache.
 * v13 → v14 (knowledge graph): seed `graphNodes` from the reading history that
 * still exists. Only articles and videos — papers, bookmarks and recordings
 * are reconciled on the first graph open, which also covers a device that
 * pulls them via sync after this migration has already run.
 * v14 → v15 (Brave accent by default): the default skin moved from 'auto' to
 * 'brave', but patchSettings persists the whole settings object, so anyone who
 * ever changed any setting has a stored 'auto' shadowing the new default.
 * Rewrite that one value. An explicit 'chrome'/'default' is a real choice and
 * is left alone — only 'auto' means "never picked".
 * v15 → v16 (dashboard presets): replace arbitrary columns/order/hide/width
 * settings with one predictable, accessible layout mode. Existing users begin
 * in Focused; their content is untouched.
 * v16 → v17 (daily brain-dump gate): add device-local completion state. A
 * qualifying note already saved today is grandfathered so an upgrade never
 * asks for the same dump twice.
 * v17 → v18 (Attention Relay): add the device-local active intention and
 * parking lot. Research data and connected Google services opt existing users
 * into their matching secondary packs; no retired data is deleted.
 * v18 → v19: add the device-local cache populated from the user's X bookmarks
 * page. It deliberately stays outside cloud-sync collections.
 */
export async function migrate(): Promise<void> {
  const stored = await chrome.storage.local.get([
    'schemaVersion',
    'refreshInterval',
    'settings',
    'gamification',
  ]);
  const version = (stored.schemaVersion as number | undefined) ?? 0;
  // Must match the version written at the end: this guard was left at 10 when
  // v11 landed, which stranded anyone already on 10 — they never ran v11.
  if (version >= 20) return;

  if (version < 1) {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ...(stored.settings ?? {}),
      ...(typeof stored.refreshInterval === 'number'
        ? { refreshInterval: stored.refreshInterval }
        : {}),
    };
    await chrome.storage.local.set({ settings });
    await chrome.storage.local.remove('refreshInterval');
  }

  if (stored.gamification) {
    const gamification = stored.gamification as Gamification;
    gamification.counters.videosFinished ??= 0;
    gamification.counters.focusBlocks ??= 0;
    await chrome.storage.local.set({ gamification });
  }

  if (version < 5) {
    const { decks, flashCards, flashNotes, papers } = await chrome.storage.local.get([
      'decks',
      'flashCards',
      'flashNotes',
      'papers',
    ]);
    const deckList = (decks as Deck[] | undefined) ?? [];
    if (deckList.length) {
      const cards = (flashCards as { deckId: string }[] | undefined) ?? [];
      const notes = (flashNotes as { deckId: string }[] | undefined) ?? [];
      const paperList = (papers as { deckId: string }[] | undefined) ?? [];
      for (const deck of deckList) {
        if (deck.kind) continue;
        const hasCards =
          cards.some((c) => c.deckId === deck.id) || notes.some((n) => n.deckId === deck.id);
        const hasPapers = paperList.some((p) => p.deckId === deck.id);
        deck.kind = hasCards ? 'flashcards' : hasPapers ? 'papers' : 'flashcards';
      }
      await chrome.storage.local.set({ decks: deckList });
    }
  }

  if (version < 6) {
    const collections = await chrome.storage.local.get([
      'tasks',
      'notes',
      'decks',
      'flashCards',
      'bookmarks',
      'bookmarkGroups',
    ]);
    const patch: Record<string, unknown> = {};
    for (const key of ['tasks', 'notes', 'decks', 'flashCards', 'bookmarks', 'bookmarkGroups']) {
      const list = collections[key] as ({ createdAt?: number; updatedAt?: number }[]) | undefined;
      if (!list?.length) continue;
      patch[key] = list.map((r) =>
        r.updatedAt == null ? { ...r, updatedAt: r.createdAt ?? 0 } : r,
      );
    }
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  }

  if (version < 7) await migrateToV7();
  if (version < 8) await migrateToV8();
  if (version < 9) await migrateToV9();
  if (version < 10) await chrome.storage.local.set({ calendar: CALENDAR_DEFAULTS });
  // v10 → v11: feed item ids were truncated to 24 bytes of input, so every
  // article on a site shared one — the stored read state marked whole sites
  // read. The ids are unmappable to the new scheme, and the old values are
  // worse than none, so start over. Everything shows unread once.
  if (version < 11) await chrome.storage.local.set({ readItems: [] });
  if (version < 12) await migrateToV12();
  if (version < 13) await migrateToV13();
  if (version < 15) await migrateToV15();
  if (version < 16) await migrateToV16();
  if (version < 17) {
    const storedGate = await chrome.storage.local.get(['notes', 'dailyBrainDumpGate']);
    await chrome.storage.local.set({
      dailyBrainDumpGate: v17DailyBrainDumpGate(
        (storedGate.notes as BrainDumpNote[] | undefined) ?? [],
        storedGate.dailyBrainDumpGate as DailyBrainDumpGateState | undefined,
      ),
    });
  }
  if (version < 18) await migrateToV18();

  if (version < 19) {
    await chrome.storage.local.set({ xBookmarks: [], xBookmarksLastSyncedAt: 0 });
  }

  if (version < 20) await migrateToV20();

  await chrome.storage.local.set({ schemaVersion: 20 });
}

/**
 * Every key belonging to a feature that has been cut. Removing them is not
 * cosmetic: `getLocal` merges DEFAULTS over what is stored, so an orphaned key
 * sits in quota forever, and `flashCards`/`recordings`-sized values are not
 * small. Settings need an explicit delete too — patchSettings writes the whole
 * merged object, so a dropped field stays on disk for anyone who ever opened
 * Settings, and changing DEFAULT_SETTINGS alone never reaches them.
 */
export const V20_DEAD_KEYS = [
  // Cloud sync + iOS
  'sync',
  'tombstones',
  // Flashcards / SRS (decks stay — papers live in them)
  'flashCards',
  'flashNotes',
  'srsDaily',
  // Knowledge graph
  'graphNodes',
  'graphView',
  'graphVisible',
  // alphaXiv
  'alphaxiv',
  // Gym, warm-up, parking lot, X bookmarks
  'gym',
  'warmup',
  'parkingLot',
  'xBookmarks',
  'xBookmarksLastSyncedAt',
  // Wake word / briefing
  'assistantBriefing',
];

export const V20_DEAD_SETTINGS = [
  'dashboardMode',
  'gymWeeklyTarget',
  'gymReminderTime',
  'assistantWakeWordEnabled',
  'ollamaBaseUrl',
  'ollamaModel',
];

/** Pure core of v20's settings half, so the delete rule is testable. */
export function v20StripSettings(
  settings: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!settings || typeof settings !== 'object') return null;
  const next = { ...settings };
  for (const key of V20_DEAD_SETTINGS) delete next[key];
  return next;
}

async function migrateToV20(): Promise<void> {
  await chrome.storage.local.remove(V20_DEAD_KEYS);
  // Read fresh rather than from the `stored` snapshot at the top of migrate():
  // that snapshot predates the version < 1 branch's own write.
  const { settings } = await chrome.storage.local.get('settings');
  const next = v20StripSettings(settings as Record<string, unknown> | undefined);
  if (next) await chrome.storage.local.set({ settings: next });
}

export function v18EnabledPacks(input: {
  papers?: readonly unknown[];
  flashNotes?: readonly unknown[];
  flashCards?: readonly unknown[];
  recordings?: readonly unknown[];
  annotations?: readonly unknown[];
  calendar?: { connected?: boolean };
  gmail?: GmailState;
  settings?: Partial<Settings>;
  enabledPacks?: readonly EnabledPack[];
}): EnabledPack[] {
  const packs = new Set<EnabledPack>(input.enabledPacks ?? []);
  if (
    input.papers?.length ||
    input.flashNotes?.length ||
    input.flashCards?.length ||
    input.recordings?.length ||
    input.annotations?.length
  ) {
    packs.add('research');
  }
  if (input.calendar?.connected || (input.gmail && connectedAccounts(input.gmail).length > 0)) {
    packs.add('work');
  }
  if (input.settings?.assistantEnabled) packs.add('assistant');
  return ['research', 'work', 'assistant'].filter((pack) => packs.has(pack as EnabledPack)) as EnabledPack[];
}

async function migrateToV18(): Promise<void> {
  const stored = await chrome.storage.local.get([
    'papers',
    'flashNotes',
    'flashCards',
    'recordings',
    'annotations',
    'calendar',
    'gmail',
    'settings',
    'enabledPacks',
  ]);
  await chrome.storage.local.set({
    enabledPacks: v18EnabledPacks(stored as Parameters<typeof v18EnabledPacks>[0]),
    activeIntent: null,
    parkingLot: [],
  });
}

export function v17DailyBrainDumpGate(
  notes: readonly BrainDumpNote[],
  state: DailyBrainDumpGateState | undefined,
  date?: string,
): DailyBrainDumpGateState {
  return gateStateForDate(
    state ?? { date: '', completedAt: null, noteId: null },
    notes,
    date,
  );
}

/** Pure core of v16: retire layout-builder state without carrying its arbitrary
 * visual order into the new semantic presets. */
export function v16DashboardMode(
  settings: (Partial<Settings> & Record<string, unknown>) | undefined,
): (Partial<Settings> & Record<string, unknown>) | null {
  if (!settings) return null;
  const next = { ...settings };
  delete next.dashColumns;
  delete next.dashCardOrder;
  delete next.dashHiddenCards;
  delete next.dashFullWidthCards;
  next.dashboardMode = 'focused';
  return next;
}

async function migrateToV16(): Promise<void> {
  const { settings } = await chrome.storage.local.get('settings');
  const patched = v16DashboardMode(
    settings as (Partial<Settings> & Record<string, unknown>) | undefined,
  );
  if (patched) await chrome.storage.local.set({ settings: patched });
}

/** Pure core of v15. Null means "nothing stored to rewrite" — an absent
 *  settings object already picks up the new default, and an explicit skin is
 *  the user's choice. */
export function v15Skin(settings: Partial<Settings> | undefined): Partial<Settings> | null {
  if (settings?.skin !== 'auto') return null;
  return { ...settings, skin: DEFAULT_SETTINGS.skin };
}

async function migrateToV15(): Promise<void> {
  const { settings } = await chrome.storage.local.get('settings');
  const patched = v15Skin(settings as Partial<Settings> | undefined);
  if (patched) await chrome.storage.local.set({ settings: patched });
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

/** v12 → v13: retire every Notion key, settings and local alike. */
async function migrateToV13(): Promise<void> {
  await chrome.storage.local.remove(['notionQueue', 'notionStatus', 'meetingNotes']);
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) return;
  const record = settings as Record<string, unknown>;
  const stale = Object.keys(record).filter((key) => key.startsWith('notion'));
  if (stale.length === 0) return;
  for (const key of stale) delete record[key];
  await chrome.storage.local.set({ settings: record });
}

/** v8 → v9: retire the old render-gate passcode hash. */
async function migrateToV9(): Promise<void> {
  const { settings } = await chrome.storage.local.get('settings');
  if (settings && 'notesPasscodeHash' in (settings as object)) {
    delete (settings as Record<string, unknown>).notesPasscodeHash;
    await chrome.storage.local.set({ settings });
  }
}

/**
 * Pure core of the v7 rewrite, so the reward-currency collapse is testable
 * without a chrome.storage stub. Returns only the keys that changed.
 */
export function v7Patch(stored: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  const gamification = stored.gamification as
    | (Gamification & { xp?: number; lastQuestCelebratedWeek?: string })
    | undefined;
  if (gamification) {
    const counters = (gamification.counters ?? {}) as LifetimeCounters & { chestsOpened?: number };
    if (counters.chestsOpened !== undefined) {
      counters.freezesEarned = counters.chestsOpened;
      delete counters.chestsOpened;
    }
    delete gamification.xp;
    delete gamification.lastQuestCelebratedWeek;
    patch.gamification = { badges: gamification.badges ?? {}, counters };
  }

  const settings = stored.settings as (Partial<Settings> & Record<string, unknown>) | undefined;
  if (settings) {
    for (const dead of [
      'questArticlesPerWeek',
      'questSprintsPerWeek',
      'questVideosPerWeek',
      'questFocusPerWeek',
    ]) {
      delete settings[dead];
    }
    // The Progress card merged into the streak card; drop its slot so the
    // grid's drop-unknown-ids reconcile doesn't have to carry it forever.
    for (const key of ['dashCardOrder', 'dashHiddenCards', 'dashFullWidthCards'] as const) {
      const list = settings[key];
      // 'progress' has left DashCardId, so compare as a plain string
      if (Array.isArray(list)) {
        settings[key] = list.filter((id) => (id as string) !== 'progress');
      }
    }
    patch.settings = settings;
  }

  // Annotations grew an anchor union when the reader learned to read articles;
  // every existing record is a PDF one.
  const legacy = stored.pdfAnnotations as
    | ({ page: number; rects: unknown[]; x: number; y: number; pdfUrl: string } & Record<string, unknown>)[]
    | undefined;
  if (legacy?.length) {
    patch.annotations = legacy.map(({ page, rects, x, y, pdfUrl, ...rest }) => ({
      ...rest,
      docUrl: pdfUrl,
      anchor: { kind: 'pdf' as const, page, rects, x, y },
    }));
  }

  // chest marked "already rolled" by carrying a bonusXp; only presence matters now
  const tasks = stored.tasks as ({ chest?: { bonusXp?: number; rolled?: true } }[]) | undefined;
  if (tasks?.some((t) => t.chest !== undefined && t.chest.rolled === undefined)) {
    patch.tasks = tasks.map((t) =>
      t.chest !== undefined ? { ...t, chest: { rolled: true as const } } : t,
    );
  }

  return patch;
}

/**
 * Every retained timestamp that marks a deliberate user action, for seeding the
 * prime-time ledger. Gym check-ins are excluded on purpose — when you lift is
 * not when you can think, and letting it in skews the peak window.
 */
export function seedTimestamps(stored: Record<string, unknown>): number[] {
  const at: number[] = [];
  const push = (...values: (number | null | undefined)[]) => {
    for (const v of values) if (typeof v === 'number' && v > 0) at.push(v);
  };
  for (const t of (stored.tasks as Task[] | undefined) ?? []) push(t.createdAt, t.completedAt);
  for (const n of (stored.notes as BrainDumpNote[] | undefined) ?? []) push(n.createdAt, n.structuredAt);
  for (const b of (stored.bookmarks as BookmarkLink[] | undefined) ?? []) push(b.createdAt);
  for (const a of (stored.annotations as Annotation[] | undefined) ?? []) push(a.createdAt);
  for (const p of (stored.papers as Paper[] | undefined) ?? []) push(p.addedAt, p.lastReadAt);
  for (const p of Object.values((stored.readingProgress as Record<string, AnyProgress>) ?? {})) {
    push(p.firstOpenedAt, p.completedAt);
  }
  return at;
}

/**
 * v7 → v8 (prime time): backfill `DayStats.hours` from the timestamps above, so
 * the punchcard opens with the user's real rhythm instead of a blank grid it
 * would take a week to fill. Only days with no ledger yet are seeded, so this
 * can never double-count against live credit from background/streaks.ts.
 */
async function migrateToV8(): Promise<void> {
  const stored = await chrome.storage.local.get([
    'streaks',
    'tasks',
    'notes',
    'bookmarks',
    'annotations',
    'flashNotes',
    'papers',
    'readingProgress',
  ]);
  const seeded = hoursFromTimestamps(seedTimestamps(stored));
  if (!Object.keys(seeded).length) return;

  const streaks = (stored.streaks as Streaks | undefined) ?? structuredClone(DEFAULTS.streaks);
  for (const [date, hours] of Object.entries(seeded)) {
    const day = streaks.daily[date];
    if (day && Object.keys(day.hours ?? {}).length > 0) continue; // live credit wins
    // A day with only evidence and no stats still scores 0 on the calendar —
    // the entry exists so the punchcard can see it
    streaks.daily[date] = { ...(day ?? { minutes: 0, sprints: 0, articlesFinished: 0 }), hours };
  }
  await chrome.storage.local.set({ streaks });
}

async function migrateToV7(): Promise<void> {
  const stored = await chrome.storage.local.get([
    'gamification',
    'settings',
    'tasks',
    'pdfAnnotations',
  ]);
  const patch = v7Patch(stored);
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  if (stored.pdfAnnotations !== undefined) await chrome.storage.local.remove('pdfAnnotations');
}
