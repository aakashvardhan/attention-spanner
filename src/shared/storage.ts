import type { AssistantTurn } from './ai/assistantTypes';
import { DEFAULT_FOCUS_BLOCKLIST } from './constants';
import { DASH_CARD_IDS } from './types';
import type {
  AnyProgress,
  BookmarkGroup,
  BookmarkLink,
  BrainDumpNote,
  Deck,
  FeedItem,
  FlashCard,
  FlashNote,
  FocusSession,
  Gamification,
  GymState,
  Paper,
  Settings,
  SrsDayStats,
  Streaks,
  Task,
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
  readingProgress: Record<string, AnyProgress>;
  streaks: Streaks;
  gym: GymState;
  gamification: Gamification;
  focusSession: FocusSession | null;
  bookmarks: BookmarkLink[];
  bookmarkGroups: BookmarkGroup[];
  decks: Deck[];
  flashNotes: FlashNote[];
  flashCards: FlashCard[];
  /** Research papers, grouped into decks (shared with flashcards) */
  papers: Paper[];
  /** Keyed by local date 'YYYY-MM-DD', pruned to SRS_DAILY_RETENTION_DAYS */
  srsDaily: Record<string, SrsDayStats>;
  /** Time-pill totals for the one local day in `date`; hosts keyed by configured domain */
  siteTime: { date: string; hosts: Record<string, number> };
  /** Today's assistant morning briefing; regenerated when `date` rolls over */
  assistantBriefing: { date: string; text: string } | null;
}

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
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  refreshInterval: 30,
  notificationsEnabled: true,
  nudgesEnabled: true,
  nudgeDelayMinutes: 3,
  nudgeCooldownMinutes: 60,
  nudgeMaxPerArticle: 2,
  taskReminderIntervalMinutes: 120,
  sprintMinutes: 5,
  dailyGoalMinutes: 5,
  gymWeeklyTarget: 3,
  gymReminderTime: '18:00',
  questArticlesPerWeek: 2,
  questSprintsPerWeek: 5,
  questVideosPerWeek: 1,
  videoMinMinutes: 15,
  hyperfocusMinutes: 90,
  timePillHosts: [],
  focusBlocklist: DEFAULT_FOCUS_BLOCKLIST,
  focusMinutes: 50,
  focusBreakMinutes: 10,
  questFocusPerWeek: 5,
  focusMusicEnabled: false,
  dashColumns: 3,
  dashCardOrder: [...DASH_CARD_IDS],
  dashHiddenCards: [],
  dashFullWidthCards: [],
  semanticScholarApiKey: '',
  assistantEnabled: true,
  geminiApiKey: '',
  assistantVoiceEnabled: false,
  assistantTtsVoice: '',
};

export const DEFAULTS: LocalSchema = {
  schemaVersion: 1,
  feeds: [],
  readItems: [],
  cachedItems: [],
  cacheTimestamp: 0,
  settings: DEFAULT_SETTINGS,
  tasks: [],
  notes: [],
  readingProgress: {},
  streaks: { currentStreak: 0, longestStreak: 0, lastQualifiedDate: '', daily: {}, freezeTokens: 0 },
  gym: { checkins: {}, currentWeekStreak: 0, longestWeekStreak: 0, lastQualifiedWeek: '' },
  gamification: {
    xp: 0,
    badges: {},
    lastQuestCelebratedWeek: '',
    counters: {
      workouts: 0,
      articlesFinished: 0,
      videosFinished: 0,
      sprints: 0,
      tasksCompleted: 0,
      brainDumps: 0,
      focusBlocks: 0,
      cardsReviewed: 0,
      chestsOpened: 0,
    },
  },
  focusSession: null,
  bookmarks: [],
  bookmarkGroups: [],
  decks: [],
  flashNotes: [],
  flashCards: [],
  papers: [],
  srsDaily: {},
  siteTime: { date: '', hosts: {} },
  assistantBriefing: null,
};

export const SESSION_DEFAULTS: SessionSchema = {
  trackedTabs: {},
  pendingResume: {},
  activeSprint: null,
  lastGlobalNudgeAt: 0,
  hyperfocus: { unbrokenSeconds: 0, lastDeltaAt: 0, notifiedAtSeconds: 0 },
  assistantThread: [],
};

export async function getLocal<K extends keyof LocalSchema>(
  ...keys: K[]
): Promise<Pick<LocalSchema, K>> {
  const stored = await chrome.storage.local.get(keys);
  const out = {} as Pick<LocalSchema, K>;
  for (const key of keys) {
    out[key] = stored[key] ?? structuredClone(DEFAULTS[key]);
  }
  return out;
}

export async function setLocal(items: Partial<LocalSchema>): Promise<void> {
  await chrome.storage.local.set(items);
}

export async function getSession<K extends keyof SessionSchema>(
  ...keys: K[]
): Promise<Pick<SessionSchema, K>> {
  const stored = await chrome.storage.session.get(keys);
  const out = {} as Pick<SessionSchema, K>;
  for (const key of keys) {
    out[key] = stored[key] ?? structuredClone(SESSION_DEFAULTS[key]);
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
 */
export async function migrate(): Promise<void> {
  const stored = await chrome.storage.local.get([
    'schemaVersion',
    'refreshInterval',
    'settings',
    'gamification',
  ]);
  const version = (stored.schemaVersion as number | undefined) ?? 0;
  if (version >= 6) return;

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
    gamification.counters.cardsReviewed ??= 0;
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

  await chrome.storage.local.set({ schemaVersion: 6 });
}
