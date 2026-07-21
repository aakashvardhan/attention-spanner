/**
 * Cloud-sync metadata mixed into every user-authored, synced record.
 * Optional so pre-sync (schemaVersion < 6) records typecheck; the v6 migration
 * backfills `updatedAt` (from createdAt) and leaves `deletedAt` unset (null).
 * Merge is last-write-wins by `updatedAt`; a set `deletedAt` is a tombstone
 * that propagates deletes and wins ties. See src/shared/sync/merge.ts.
 */
export interface SyncMeta {
  updatedAt?: number;
  deletedAt?: number | null;
}

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
  /** Feed-declared category/tag labels; absent on pre-category cached items */
  categories?: string[];
}

export interface Task extends SyncMeta {
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

/**
 * A lasting fact the user asked the assistant to remember ("I lift Mon/Wed/
 * Fri"). Device-local v1; carries updatedAt so future sync needs no migration.
 */
export interface AssistantFact {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

export type AutomationSchedule =
  | { kind: 'daily'; time: string /* HH:MM local */ }
  | { kind: 'every'; minutes: number };

/**
 * A scheduled agent run: on its schedule the agent gets the user's data
 * snapshot plus this prompt, does discovery/triage on its own, and leaves a
 * digest (and up to a few proposed actions behind confirm chips) in the
 * assistant chat. Device-local.
 */
export interface AssistantAutomation {
  id: string;
  name: string;
  /** What to discover/triage each run ("review my open tasks, pick 3 for today") */
  prompt: string;
  schedule: AutomationSchedule;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number;
  lastDigest: string;
  /** '' = healthy; surfaced on the automation row in settings */
  lastError: string;
}

/**
 * One agent-proposed tool call, applied atomically in the service worker
 * (src/background/agentRuns.ts). The optional precondition pins the record
 * state the proposer saw — the apply step skips as stale when the target
 * changed or vanished since (updatedAt/tombstone check).
 */
export interface AgentProposal {
  tool: string;
  params: Record<string, unknown>;
  /** Human phrasing, for skipped/failed transcript lines */
  summary: string;
  precondition?: { collection: string; id: string; snapshotAt: number };
}

/**
 * A skill: user-written instructions the assistant consults instead of
 * guessing ("tasks are always phrased as verbs; grocery items go in the
 * Errands deck"). Unlike 280-char memory facts (data about the user), skills
 * are markdown *instructions* selected by keyword/tool relevance and injected
 * into prompts. Device-local, like assistantMemory.
 */
export interface AssistantSkill {
  id: string;
  name: string;
  /** Utterance keywords that select this skill (lowercase) */
  keywords: string[];
  /** Markdown instructions, capped at SKILL_MAX_CHARS */
  body: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface BrainDumpNote extends SyncMeta {
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
  'feeds',
  'agenda',
  'links',
  'tasks',
  'continue',
  'streak',
  'gym',
  'progress',
  'braindump',
  'flashcards',
  'papers',
  'meetings',
  'warmup',
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
  /** Meeting-notes database to pull from; '' = feature off (no separate toggle) */
  notionMeetingNotesDbId: string;
  /** Date property in that DB; '' = order/date by last_edited_time */
  notionMeetingNotesDateProp: string;
  /** Semantic Scholar API key for paper metadata lookups; '' = unauthenticated */
  semanticScholarApiKey: string;
  /** The Jarvis assistant (dashboard card, popup tab, command palette) */
  assistantEnabled: boolean;
  /** Gemini API key for cloud fallback on long/hard queries; '' = on-device only */
  geminiApiKey: string;
  /** Speak assistant replies aloud (TTS) */
  assistantVoiceEnabled: boolean;
  /** speechSynthesis voice name; '' = system default */
  assistantTtsVoice: string;
  /** Always-on "Hey Jarvis" wake word (offscreen mic listener) */
  assistantWakeWordEnabled: boolean;
  /** Create a "🎯 Focus" Google Calendar event when a focus session starts */
  focusCalendarBlockEnabled: boolean;
  /** Proactive Jarvis nudges: streak-at-risk / cards-due evening check + event reminders */
  assistantMonitorEnabled: boolean;
  /** Local 'HH:MM' bounds where the monitor stays silent (wraps overnight) */
  monitorQuietStart: string;
  monitorQuietEnd: string;
  /** Local 'HH:MM' for the daily evening check; '' = off */
  monitorEveningTime: string;
}

/* Flashcards (Anki-style SRS). One authored FlashNote generates N reviewable
   FlashCards (cloze indexes / reversed direction); card ids are deterministic
   `${noteId}#${variant}` so note edits reconcile instead of resetting scheduling. */

/** A deck is dedicated to one purpose — flashcards or research papers. */
export type DeckKind = 'flashcards' | 'papers';

export interface Deck extends SyncMeta {
  id: string;
  name: string;
  createdAt: number;
  /** Decks created before this field default to 'flashcards' (see migrate) */
  kind: DeckKind;
}

export type FlashNoteType = 'basic' | 'cloze';

export interface FlashNote extends SyncMeta {
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

export interface FlashCard extends SyncMeta {
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

/* Research papers. Each paper belongs to a Deck (shared with flashcards), so a
   deck holds both the papers you read and the cards you make from them. Reading
   progress is tracked automatically when the paper is read in the in-extension
   PDF reader (src/pages/reader/); it can still be edited manually. */

export type PaperStatus = 'to-read' | 'reading' | 'read';

export interface Paper extends SyncMeta {
  id: string;
  /** Reuses Deck.id — the same decks as flashcards */
  deckId: string;
  title: string;
  /** Comma-joined author names */
  authors: string;
  /** Conference / journal */
  venue: string;
  year: number | null;
  /** Citation count from the metadata lookup */
  citations: number | null;
  /** arXiv / DOI / paper URL; used by "Open paper" */
  url: string;
  /** The abstract / description */
  abstract: string;
  /** Free text: why this paper matters to me */
  relevance: string;
  status: PaperStatus;
  /** 0–100; auto-ratcheted by the PDF reader, editable by hand */
  progressPercent: number;
  /** "Where I left off" note, e.g. "Section 4.2 — ablations" */
  leftOff: string;
  /** Set by the in-extension PDF reader; absent until the paper is opened there */
  pdf?: {
    /** The PDF URL the reader loaded (`url` above is often the abs/DOI page) */
    url: string;
    /** 1-based page the user was last on */
    page: number;
    pageCount: number;
    /** Scroll position within `page`, 0–1 */
    offset: number;
  };
  addedAt: number;
  updatedAt: number;
  /** Bumped whenever status/progress changes while reading */
  lastReadAt: number | null;
}

/** The editable fields of a Paper; the service worker fills id/timestamps. */
export type PaperDraft = Omit<Paper, 'id' | 'addedAt' | 'updatedAt' | 'lastReadAt'>;

/* PDF reader annotations: text highlights and free-floating sticky notes made
   in src/pages/reader/. Keyed by docKey (not paperId) so they work on
   untracked PDFs and survive arXiv abs/pdf URL variants. Local-only for now,
   but id-addressable + SyncMeta so per-record sync can be added later. */

export type AnnotationColor = 'yellow' | 'green' | 'blue' | 'pink';

/** One box on a page; all fields 0–1 fractions of the page size (y-down). */
export interface AnnotationRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfAnnotation extends SyncMeta {
  id: string;
  /** Stable doc identity: paperMatchKey(pdfUrl) ?? pdfUrl */
  docKey: string;
  /** The exact PDF URL the annotation was made on */
  pdfUrl: string;
  /** Tracked paper at creation time; null for untracked PDFs */
  paperId: string | null;
  kind: 'highlight' | 'sticky';
  /** 1-based */
  page: number;
  /** highlight: merged per-line boxes; sticky: [] */
  rects: AnnotationRect[];
  /** Sticky pin anchor, 0–1 of the page box; 0 for highlights */
  x: number;
  y: number;
  /** Selected text snippet (highlights, capped) or '' */
  text: string;
  color: AnnotationColor;
  /** The attached note; '' = none */
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** Draft from the reader; the service worker fills id/timestamps. */
export type PdfAnnotationDraft = Omit<PdfAnnotation, 'id' | 'createdAt' | 'updatedAt'>;

export interface BookmarkGroup extends SyncMeta {
  id: string;
  name: string;
  createdAt: number;
}

export interface BookmarkLink extends SyncMeta {
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
  /** Google Calendar "🎯 Focus" event created for this session (time-blocking) */
  calendarEventId?: string;
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

export interface WarmupState {
  /** Local date 'YYYY-MM-DD' → that day's best Stroop sprint; pruned to a year */
  days: Record<string, { score: number; accuracy: number }>;
  /** Consecutive days with at least one completed warm-up */
  currentStreak: number;
  longestStreak: number;
  /** Local date of the most recent completion; '' = never */
  lastPlayedDate: string;
  bestScore: number;
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
  /** Added with the warm-up card — read with `?? 0` */
  warmups?: number;
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
