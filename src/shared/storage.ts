import { DEFAULT_FOCUS_BLOCKLIST } from './constants';
import type { NotionPush, NotionStatus } from './notion';
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
  notionQueue: NotionPush[];
  notionStatus: NotionStatus;
  decks: Deck[];
  flashNotes: FlashNote[];
  flashCards: FlashCard[];
  /** Keyed by local date 'YYYY-MM-DD', pruned to SRS_DAILY_RETENTION_DAYS */
  srsDaily: Record<string, SrsDayStats>;
  /** Time-pill totals for the one local day in `date`; hosts keyed by configured domain */
  siteTime: { date: string; hosts: Record<string, number> };
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
  notionToken: '',
  notionLinksDbId: '',
  notionBrainDumpDbId: '',
  notionTasksDbId: '',
  notionReadingLogDbId: '',
  notionTasksDoneProp: '',
  notionLinksUrlProp: 'URL',
  notionLinksTagsProp: 'Tags',
  notionReadingUrlProp: 'URL',
  notionReadingTypeProp: 'Type',
  notionReadingDateProp: 'Finished',
  notionPushLinks: false,
  notionPushBrainDumps: false,
  notionPushTasks: false,
  notionPushReading: false,
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
  notionQueue: [],
  notionStatus: { lastSuccessAt: 0, lastError: '', lastErrorAt: 0, authError: false },
  decks: [],
  flashNotes: [],
  flashCards: [],
  srsDaily: {},
  siteTime: { date: '', hosts: {} },
};

export const SESSION_DEFAULTS: SessionSchema = {
  trackedTabs: {},
  pendingResume: {},
  activeSprint: null,
  lastGlobalNudgeAt: 0,
  hyperfocus: { unbrokenSeconds: 0, lastDeltaAt: 0, notifiedAtSeconds: 0 },
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
 */
export async function migrate(): Promise<void> {
  const stored = await chrome.storage.local.get([
    'schemaVersion',
    'refreshInterval',
    'settings',
    'gamification',
  ]);
  const version = (stored.schemaVersion as number | undefined) ?? 0;
  if (version >= 4) return;

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

  await chrome.storage.local.set({ schemaVersion: 4 });
}
