export interface FeedItem {
  /** btoa(encodeURIComponent(link + title)).slice(0, 32) — same scheme as the legacy extension */
  id: string;
  title: string;
  link: string;
  normalizedLink: string;
  /** ISO 8601 */
  pubDate: string;
  /** HTML-stripped, max 200 chars */
  snippet: string;
  /** Feed (channel) title */
  source: string;
}

export interface Task {
  id: string;
  text: string;
  createdAt: number;
  completedAt: number | null;
  /** Excluded from reminder digests until this timestamp */
  snoozedUntil: number | null;
  source: 'capture' | 'popup' | 'newtab' | 'braindump';
  /** Notion page created for this task; set after the create push succeeds */
  notionPageId?: string;
  /**
   * Mystery-chest roll for this task, made once on first completion
   * (bonusXp 0 = rolled and missed). Present ⇒ never re-roll, so
   * toggle-farming can't fish for a drop.
   */
  chest?: { bonusXp: number };
}

export interface BrainDumpNote {
  id: string;
  rawText: string;
  /** 'raw' = saved but not yet structured (AI unavailable or interrupted) */
  status: 'raw' | 'structured' | 'failed';
  bullets: string[];
  /** addedTaskId links a proposed task to the real Task it became (null = not added) */
  proposedTasks: { text: string; addedTaskId: string | null }[];
  createdAt: number;
  structuredAt: number | null;
  /** Set at enqueue time of the note's one Notion push; pre-Notion notes lack it (read with == null) */
  notionPushedAt?: number | null;
}

/** UI color theme; 'system' follows the OS prefers-color-scheme */
export type ThemeSetting = 'light' | 'dark' | 'system';

export const DASH_CARD_IDS = [
  'links',
  'tasks',
  'continue',
  'streak',
  'gym',
  'progress',
  'braindump',
  'flashcards',
] as const;
export type DashCardId = (typeof DASH_CARD_IDS)[number];

export interface Settings {
  theme: ThemeSetting;
  /** Feed refresh interval in minutes (15–360) */
  refreshInterval: number;
  notificationsEnabled: boolean;
  nudgesEnabled: boolean;
  /** Minutes away from a partially-read article before a nudge fires */
  nudgeDelayMinutes: number;
  /** Per-article cooldown between nudges, minutes */
  nudgeCooldownMinutes: number;
  nudgeMaxPerArticle: number;
  /** 0 = reminders off */
  taskReminderIntervalMinutes: number;
  sprintMinutes: number;
  /** Minutes of active reading for a day to count toward the streak */
  dailyGoalMinutes: number;
  /** Gym sessions per week to keep the gym streak (1–7) */
  gymWeeklyTarget: number;
  /** Local 'HH:MM' for the daily gym reminder; '' = off */
  gymReminderTime: string;
  /** Weekly quest targets; 0 excludes the line from the quest */
  questArticlesPerWeek: number;
  questSprintsPerWeek: number;
  questVideosPerWeek: number;
  /** Only auto-track YouTube videos at least this long */
  videoMinMinutes: number;
  /** Unbroken engagement minutes before the hyperfocus break nudge; 0 = off */
  hyperfocusMinutes: number;
  /** Domains that get the floating time-on-site pill */
  timePillHosts: string[];
  /** Domains blocked during focus sessions */
  focusBlocklist: string[];
  focusMinutes: number;
  focusBreakMinutes: number;
  questFocusPerWeek: number;
  /** Auto-open Flowtunes in a pinned tab when a focus session starts */
  focusMusicEnabled: boolean;
  /** Dashboard grid columns (1–4); narrow viewports still collapse responsively */
  dashColumns: 1 | 2 | 3 | 4;
  /** Dashboard card order, source of truth for grid flow */
  dashCardOrder: DashCardId[];
  dashHiddenCards: DashCardId[];
  dashFullWidthCards: DashCardId[];
  /** Notion internal integration token; '' = integration off */
  notionToken: string;
  /** Target database ids per push kind; '' = that push unconfigured */
  notionLinksDbId: string;
  notionBrainDumpDbId: string;
  notionTasksDbId: string;
  notionReadingLogDbId: string;
  /** Checkbox property name in the tasks DB for completion sync; '' = creates only */
  notionTasksDoneProp: string;
  /** Property names detected by type when a DB is picked; '' = DB lacks that type */
  notionLinksUrlProp: string;
  notionLinksTagsProp: string;
  notionReadingUrlProp: string;
  notionReadingTypeProp: string;
  notionReadingDateProp: string;
  notionPushLinks: boolean;
  notionPushBrainDumps: boolean;
  notionPushTasks: boolean;
  notionPushReading: boolean;
}

/* Flashcards (Anki-style SRS). One authored FlashNote generates N reviewable
   FlashCards (cloze indexes / reversed direction); card ids are deterministic
   `${noteId}#${variant}` so note edits reconcile instead of resetting scheduling. */

export interface Deck {
  id: string;
  name: string;
  createdAt: number;
}

export type FlashNoteType = 'basic' | 'cloze';

export interface FlashNote {
  id: string;
  deckId: string;
  type: FlashNoteType;
  /** Basic: front text. Cloze: the {{c1::...}}-marked text. */
  front: string;
  /** Basic: back text. Cloze: optional extra info shown on the back. */
  back: string;
  /** Basic only: also generate a Back→Front card */
  reversed: boolean;
  createdAt: number;
  updatedAt: number;
}

export type CardPhase = 'new' | 'learning' | 'review' | 'relearning';
export type Rating = 'again' | 'hard' | 'good' | 'easy';

export interface FlashCard {
  /** `${noteId}#${variant}` — deterministic, survives note edits */
  id: string;
  noteId: string;
  /** Denormalized so queue building needs no join */
  deckId: string;
  /** Basic: 0 = front→back, 1 = back→front. Cloze: the cloze index (1..N). */
  variant: number;
  phase: CardPhase;
  /** Position within learning/relearning steps */
  stepIndex: number;
  /** Ease factor; starts 2.5, floor 1.3 */
  ease: number;
  /** 0 while new/learning; days once in review */
  intervalDays: number;
  /** ms epoch when the card next comes due */
  dueAt: number;
  lapses: number;
  reps: number;
  createdAt: number;
}

/** Per-local-day review aggregates (stats chart + the 20-new-per-day limit) */
export interface SrsDayStats {
  /** deckId → cards answered that day */
  reviews: Record<string, number>;
  /** deckId → new cards introduced that day */
  newIntroduced: Record<string, number>;
}

export interface BookmarkGroup {
  id: string;
  name: string;
  createdAt: number;
}

export interface BookmarkLink {
  id: string;
  url: string;
  title: string;
  /** null renders under "Unsorted" */
  groupId: string | null;
  createdAt: number;
}

export interface FocusSession {
  mode: 'oneshot' | 'pomodoro';
  phase: 'focus' | 'break';
  startedAt: number;
  phaseEndsAt: number;
  focusMinutes: number;
  breakMinutes: number;
  /** Pomodoro focus blocks completed so far this session */
  completedBlocks: number;
  /** Ignition mode: the task this micro-sprint is scoped to */
  taskId?: string;
  /** Ignition mode: the tiny first action shown in the banner and blocked page */
  intent?: string;
}

export interface GymState {
  /** Local date 'YYYY-MM-DD' → check-in timestamp; max one per day */
  checkins: Record<string, number>;
  /** Consecutive weeks hitting the weekly target */
  currentWeekStreak: number;
  longestWeekStreak: number;
  /** weekKey (Monday) of the most recent qualified week; '' = none */
  lastQualifiedWeek: string;
}

/** Survive pruning of readingProgress/streaks.daily/gym.checkins — badge math uses these */
export interface LifetimeCounters {
  workouts: number;
  articlesFinished: number;
  videosFinished: number;
  sprints: number;
  tasksCompleted: number;
  brainDumps: number;
  focusBlocks: number;
  cardsReviewed: number;
  /** Added in Phase 15 (mystery chests) — read with `?? 0` */
  chestsOpened?: number;
}

export interface Gamification {
  xp: number;
  /** badgeId → unlockedAt (ms). Badges are never revoked. */
  badges: Record<string, number>;
  /** weekKey of the last week whose quest-complete celebration fired */
  lastQuestCelebratedWeek: string;
  counters: LifetimeCounters;
}

interface ProgressBase {
  /** Original URL, used for reopening */
  url: string;
  title: string;
  /** Feed title for articles; channel name for videos */
  source: string;
  /** 0–100, monotonically increasing */
  maxPercent: number;
  /** Active reading seconds / watched playback seconds */
  activeSeconds: number;
  firstOpenedAt: number;
  updatedAt: number;
  /** Set when maxPercent >= 90 */
  completedAt: number | null;
  nudge: {
    count: number;
    lastAt: number;
    dismissed: boolean;
  };
}

export interface ReadingProgress extends ProgressBase {
  /** Optional: entries stored before Phase 6 have no kind field */
  kind?: 'article';
  feedItemId: string | null;
  scrollY: number;
  pageHeight: number;
}

export interface VideoProgress extends ProgressBase {
  kind: 'video';
  videoId: string;
  durationSeconds: number;
  positionSeconds: number;
}

export type AnyProgress = ReadingProgress | VideoProgress;

export interface DayStats {
  minutes: number;
  sprints: number;
  articlesFinished: number;
  /** Added in Phase 6 — read with `?? 0`, pre-existing days lack it */
  videosFinished?: number;
  /** Added in Phase 7 — read with `?? 0` */
  focusBlocks?: number;
  /** Added in Phase 14 (activity calendar) — read with `?? 0` */
  tasksCompleted?: number;
}

export interface Streaks {
  currentStreak: number;
  longestStreak: number;
  /** Local date 'YYYY-MM-DD' */
  lastQualifiedDate: string;
  /** Keyed by local date 'YYYY-MM-DD', pruned to a 365-day window */
  daily: Record<string, DayStats>;
  /** Streak-insurance freeze tokens (Phase 15) — read with `?? 0` */
  freezeTokens?: number;
}
