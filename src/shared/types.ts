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
  /** 16 hex chars, hashed from link + title — see generateItemId */
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
  source: 'capture' | 'popup' | 'newtab' | 'braindump' | 'recording';
  /**
   * The variable-ratio drop was rolled for this task on its first completion.
   * Present ⇒ never re-roll, so toggle-farming can't fish for a drop.
   */
  chest?: { rolled: true };
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

/**
 * One priority on a day's plan. `taskId` links back to the real Task when the
 * priority came from the task list, so ticking it here can complete it there;
 * null means the plan invented it (a meeting to prepare for, say).
 */
export interface PlanPriority {
  text: string;
  taskId: string | null;
  estimateMin: number;
  done: boolean;
}

/** A block on the day's schedule. Times are local 'HH:MM'. */
export interface PlanBlock {
  start: string;
  end: string;
  label: string;
  /** 'calendar' blocks mirror a real event; 'plan' blocks are this plan's suggestion */
  source: 'calendar' | 'plan';
}

/**
 * The plan for one local day: what matters, when it happens, and — once the
 * day is closed out — how it actually went. Unlike `assistantBriefing` (a
 * sentence that is overwritten each morning) a plan is a durable record the
 * weekly review reads back, which is the whole point of keeping it.
 */
export interface DayPlan {
  date: string;
  priorities: PlanPriority[];
  blocks: PlanBlock[];
  generatedAt: number;
  /** null until the user closes out the day */
  reviewedAt: number | null;
  /** One line the user wrote at close-out; '' when they skipped it */
  reflection: string;
}

/**
 * Something that happened on a day, recorded as it happened. The journal is
 * what gives the assistant memory across browser restarts — `assistantThread`
 * is session-scoped and evaporates, so without this the only durable context
 * is the 50 remembered facts.
 */
export interface JournalEntry {
  id: string;
  at: number;
  kind: 'briefing' | 'digest' | 'action' | 'review' | 'note';
  text: string;
}

export interface JournalDay {
  date: string;
  plan: DayPlan | null;
  entries: JournalEntry[];
}

/**
 * A week's reckoning, keyed by weekKey(). The counts inside `summary` are
 * computed by buildWeekSummary and only narrated by the model — a review that
 * hallucinates its own numbers is worse than no review.
 */
export interface WeekReview {
  weekKey: string;
  summary: string;
  /** The three things the user committed to for the following week */
  priorities: string[];
  createdAt: number;
}

/**
 * A brain dump. When the notes vault is on, the three content fields are blank
 * and their `enc*` twins hold AES-256-GCM ciphertext instead (see
 * shared/notesVault.ts). Everything else stays plain text so streaks, badges,
 * the prime-time ledger and the sync merge keep working without the passcode.
 *
 * Invariant: `encRaw` present ⇒ `rawText` is '', `bullets` is [] and every
 * `proposedTasks[i].text` is ''.
 */
export interface BrainDumpNote extends SyncMeta {
  id: string;
  rawText: string;
  /** Sealed rawText. Presence of this field is what marks a note encrypted. */
  encRaw?: string;
  /** 'raw' = saved but not yet structured (AI unavailable or interrupted) */
  status: 'raw' | 'structured' | 'failed';
  bullets: string[];
  /** Sealed JSON array of bullets */
  encBullets?: string;
  /** addedTaskId links a proposed task to the real Task it became (null = not added) */
  proposedTasks: { text: string; addedTaskId: string | null; encText?: string }[];
  createdAt: number;
  structuredAt: number | null;
}

/** Device-local daily browsing gate; completion never syncs across profiles. */
export interface DailyBrainDumpGateState {
  /** Active local calendar date in YYYY-MM-DD form. */
  date: string;
  completedAt: number | null;
  noteId: string | null;
}

export type EnabledPack = 'research' | 'work' | 'assistant';

export interface IntentResumeContext {
  kind: 'article' | 'pdf' | 'video' | 'web';
  url: string;
  title: string;
  /** Reading position fields are optional because each medium uses a different one. */
  scrollY?: number;
  page?: number;
  offset?: number;
  positionSeconds?: number;
  /** The user's small handoff note: what to do immediately after returning. */
  breadcrumb: string;
}

/**
 * The single commitment shown on Now. Device-local: it is live attention
 * state, not a durable task or a syncable knowledge record.
 */
export interface ActiveIntent {
  id: string;
  text: string;
  source: 'brainDump' | 'task' | 'calendar' | 'resume' | 'manual';
  sourceId: string | null;
  fromTodayBrainDump: boolean;
  createdAt: number;
  startedAt: number | null;
  state: 'ready' | 'active' | 'paused' | 'blocked';
  resumeContext: IntentResumeContext | null;
}

/** A thought deliberately captured without promoting it to a task. */
export interface ParkingLotItem {
  id: string;
  text: string;
  createdAt: number;
}

/** UI color theme; 'system' follows the OS prefers-color-scheme */
export type ThemeSetting = 'light' | 'dark' | 'system';

/**
 * Which browser's visual language the UI borrows. Purely cosmetic — it retints
 * the accent family and glass, and never changes what a surface can do.
 * 'auto' resolves to the browser actually running the extension.
 */
export type SkinSetting = 'auto' | 'default' | 'chrome' | 'brave';

export const DASH_CARD_IDS = [
  'feeds',
  'dayplan',
  'agenda',
  'inbox',
  'links',
  'tasks',
  'continue',
  'streak',
  'gym',
  'braindump',
  'flashcards',
  'papers',
  'recordings',
  'warmup',
] as const;
export type DashCardId = (typeof DASH_CARD_IDS)[number];
export type DashboardMode = 'focused' | 'balanced' | 'research';

export interface Settings {
  theme: ThemeSetting;
  /** Match the host browser's visual language; 'auto' follows the browser it runs in */
  skin: SkinSetting;
  /** Feed refresh interval in minutes (15–360) */
  refreshInterval: number;
  notificationsEnabled: boolean;
  nudgesEnabled: boolean;
  /** 0 = reminders off */
  taskReminderIntervalMinutes: number;
  sprintMinutes: number;
  /** Minutes of active reading for a day to count toward the streak */
  dailyGoalMinutes: number;
  /** Gym sessions per week to keep the gym streak (1–7) */
  gymWeeklyTarget: number;
  /** Local 'HH:MM' for the daily gym reminder; '' = off */
  gymReminderTime: string;
  /** Warn after a long unbroken reading/watching run (HYPERFOCUS_MINUTES) */
  hyperfocusEnabled: boolean;
  /** Domains that get the floating time-on-site pill */
  timePillHosts: string[];
  /** Domains blocked during focus sessions */
  focusBlocklist: string[];
  focusMinutes: number;
  focusBreakMinutes: number;
  /** Auto-open Flowtunes in a pinned tab when a focus session starts */
  focusMusicEnabled: boolean;
  /** Curated dashboard hierarchy; presets keep visual and keyboard order aligned. */
  dashboardMode: DashboardMode;
  /** Semantic Scholar API key for paper metadata lookups; '' = unauthenticated */
  semanticScholarApiKey: string;
  /** The Jarvis assistant (dashboard card, popup tab, command palette) */
  assistantEnabled: boolean;
  /** Gemini API key for cloud fallback on long/hard queries; '' = on-device only */
  geminiApiKey: string;
  /** Anthropic (Claude) API key for the cloud provider; '' = not configured */
  anthropicApiKey: string;
  /** Which cloud provider the assistant escalates to when on-device Nano can't cope */
  cloudProvider: 'gemini' | 'anthropic';
  /** Local OpenAI-compatible endpoint (Ollama, vLLM, llama.cpp); '' = off.
   *  Empty by default so nothing probes localhost unless it was asked to. */
  ollamaBaseUrl: string;
  /** Model name to request from the local endpoint */
  ollamaModel: string;
  /** Let the assistant run a ReAct loop — call read-only tools, see what came
   *  back, and decide what to do next — instead of the one-shot planner.
   *  Mutating tools are still staged behind the confirm chip either way. */
  assistantReactEnabled: boolean;
  /** Speak assistant replies aloud (TTS) */
  assistantVoiceEnabled: boolean;
  /** speechSynthesis voice name; '' = system default */
  assistantTtsVoice: string;
  /** Always-on "Hey Jarvis" wake word (offscreen mic listener) */
  assistantWakeWordEnabled: boolean;
  /** Describe slides/screens during tab recordings and let the assistant see
   *  the current tab when asked — frames go to Gemini, like recorded audio */
  assistantVisionEnabled: boolean;
  /** Live mode: transcribe on speech boundaries during a recording rather than
   *  every five minutes, so the transcript (and suggested answers) arrive while
   *  the meeting is still happening. Off by default — it trades a real increase
   *  in API calls for latency, which is only worth it when you're in the room. */
  assistantLiveEnabled: boolean;
  /** Create a "Focus" Google Calendar event when a focus session starts */
  focusCalendarBlockEnabled: boolean;
  /** Proactive Jarvis nudges: streak-at-risk / cards-due evening check + event reminders */
  assistantMonitorEnabled: boolean;
  /** Local 'HH:MM' for the daily inbox triage; '' = off */
  gmailTriageTime: string;
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

/* Reader annotations: text highlights and free-floating sticky notes made in
   src/pages/reader/. Keyed by docKey (not paperId) so they work on untracked
   documents and survive arXiv abs/pdf URL variants.

   The anchor is a discriminated union because the reader handles two document
   kinds with incompatible coordinate systems. A PDF page is a fixed box, so a
   highlight is a set of 0-1 rects on a page. An article reflows, so the same
   rects would be meaningless the moment the window resizes — text anchors are
   a W3C TextQuoteSelector (quote plus surrounding context) resolved against
   the extracted blocks at load time.

   Local-only, but id-addressable + SyncMeta so per-record sync can be added. */

export type AnnotationColor = 'yellow' | 'green' | 'blue' | 'pink';

/** One box on a page; all fields 0-1 fractions of the page size (y-down). */
export interface AnnotationRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AnnotationAnchor =
  | {
      kind: 'pdf';
      /** 1-based */
      page: number;
      /** highlight: merged per-line boxes; sticky: [] */
      rects: AnnotationRect[];
      /** Sticky pin anchor, 0-1 of the page box; 0 for highlights */
      x: number;
      y: number;
    }
  | {
      kind: 'text';
      /** Index of the extracted block the quote starts in — the search hint */
      blockIndex: number;
      /** The exact selected text */
      quote: string;
      /** Up to TEXT_ANCHOR_CONTEXT_CHARS either side, to disambiguate repeats */
      prefix: string;
      suffix: string;
    };

export interface Annotation extends SyncMeta {
  id: string;
  /** Stable doc identity: paperMatchKey(url) ?? normalized url */
  docKey: string;
  /** The exact document URL the annotation was made on */
  docUrl: string;
  /** Tracked paper at creation time; null for untracked documents */
  paperId: string | null;
  kind: 'highlight' | 'sticky';
  anchor: AnnotationAnchor;
  /** Selected text snippet (highlights, capped) or '' */
  text: string;
  color: AnnotationColor;
  /** The attached note; '' = none */
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** Draft from the reader; the service worker fills id/timestamps. */
export type AnnotationDraft = Omit<Annotation, 'id' | 'createdAt' | 'updatedAt'>;

/** An annotation the PDF viewport can position — narrowed for those components. */
export type PdfAnchoredAnnotation = Annotation & {
  anchor: Extract<AnnotationAnchor, { kind: 'pdf' }>;
};

export function isPdfAnchored(a: Annotation): a is PdfAnchoredAnnotation {
  return a.anchor.kind === 'pdf';
}

/** An annotation anchored in reflowing text. */
export type TextAnchoredAnnotation = Annotation & {
  anchor: Extract<AnnotationAnchor, { kind: 'text' }>;
};

export function isTextAnchored(a: Annotation): a is TextAnchoredAnnotation {
  return a.anchor.kind === 'text';
}

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

/** A bookmark observed on the signed-in user's X bookmarks page. Device-local. */
export interface XBookmark {
  /** The numeric status id, stable across x.com and twitter.com URLs. */
  id: string;
  url: string;
  text: string;
  authorName: string;
  authorHandle: string;
  /** Tweet publication time when X exposes it, otherwise null. */
  postedAt: number | null;
  /** Last time this bookmark was visible during an X sync. */
  capturedAt: number;
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
  /** Google Calendar "Focus" event created for this session (time-blocking) */
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
  /** Freeze tokens banked from the variable-ratio drop — read with `?? 0` */
  freezesEarned?: number;
  /** Added with the warm-up card — read with `?? 0` */
  warmups?: number;
}

/**
 * Habit bookkeeping. Held an XP total and weekly-quest state until those were
 * removed — streak days is the one visible signal now, and these counters
 * exist to drive one-time milestones and the assistant's data snapshot.
 */
export interface Gamification {
  /** milestoneId → unlockedAt (ms). Never revoked. */
  badges: Record<string, number>;
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
  /**
   * Whether the last tracker report was a heartbeat rather than a stop flush.
   * A hint, not a fact — a tab that dies mid-playback leaves it stuck true, so
   * always pair it with the staleness check in `isWatchingNow`.
   * Absent on entries written before this field existed; read with `=== true`.
   */
  playing?: boolean;
}

export type AnyProgress = ReadingProgress | VideoProgress;

export type GraphNodeKind =
  | 'article'
  | 'video'
  | 'paper'
  | 'bookmark'
  | 'recording'
  /** A paper the user does not have, reached from another paper's citations */
  | 'external'
  /** A brain dump — projected in memory only, never stored (see graphNodes.ts) */
  | 'note'
  /** A highlight carrying a note or a substantial quote; also never stored */
  | 'highlight';

/**
 * One thing the user consumed, as a durable vertex in the knowledge graph.
 *
 * Deliberately not a mirror of the live records. For articles and videos this
 * IS the history: `readingProgress` is a rolling cache (tracking.prune drops
 * completed entries after 14 days) and `cachedItems` forgets a FeedItem's
 * categories after 300 items, so the node is captured at tracking time or not
 * at all. Paper/bookmark/recording nodes are reconciled from their own
 * collections instead — those records are durable, and reconciling propagates
 * deletions for free. See background/graphNodes.ts.
 */
export interface GraphNode {
  /**
   * Reuses the key helper each kind already has, so a node and its source can
   * never desync: normalizeUrl(url) for articles, videoKey(id) ('yt:<id>') for
   * videos, `paper:<id>`, `bm:<id>`, recordingDocUrl(id) ('recording:<id>').
   */
  id: string;
  kind: GraphNodeKind;
  title: string;
  /** Where the node opens — http(s), or a reader URL for recordings */
  url: string;
  /** Provenance line: feed title, channel, venue, or group name; '' if none */
  source: string;
  /** Structural foreign keys — a node carries only the one its kind has */
  deckId?: string;
  groupId?: string | null;
  videoId?: string;
  /** Topic labels: deterministic first, AI-enriched later (see graphTags.ts) */
  tags: string[];
  /** 'manual' labels are user-owned and are never replaced by enrichment. */
  tagSource: 'auto' | 'ai' | 'manual';
  /** hash32 of the text the tags came from — the re-tagging idempotency key */
  tagInputHash: string;
  /** 0–1, how much of it was actually consumed */
  completion: number;
  firstSeenAt: number;
  updatedAt: number;
}

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
  /**
   * Added in Phase 22 (prime time) — hour '0'–'23' → activity points credited
   * in that hour. Read with `?? {}`; days recorded before this lack it.
   */
  hours?: Record<string, number>;
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
