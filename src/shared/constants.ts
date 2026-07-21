export const ACCENT_COLOR = '#0ea5e9';

export const RSS2JSON_API = 'https://api.rss2json.com/v1/api.json?rss_url=';
export const FETCH_TIMEOUT_MS = 15000;
export const CACHE_TTL_MS = 5 * 60 * 1000;

export const MAX_READ_ITEMS = 500;
export const MAX_LIST_ITEMS = 50;
export const COMPLETED_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const MAX_NOTES = 100;
export const MAX_DUMP_CHARS = 4000;
export const GYM_WINDOW_DAYS = 365;

export const DEFAULT_FOCUS_BLOCKLIST = [
  'mail.google.com',
  'linkedin.com',
  'netflix.com',
  'amazon.com',
  'hulu.com',
  'hbomax.com',
  'max.com',
];
export const FOCUS_PRESETS = [25, 50, 90] as const;
export const FOCUS_DNR_ID_BASE = 1000;
export const BLOCKED_PAGE_PATH = 'src/pages/blocked/index.html';
export const HOLD_TO_QUIT_MS = 5000;
export const FLOWTUNES_URL = 'https://www.flowtunes.app/';
export const MAX_BOOKMARKS = 200;

/* Flashcards. Caps keep chrome.storage.local well under quota (no
   unlimitedStorage permission yet — add it if decks ever need to grow). */
export const MAX_DECKS = 50;
export const MAX_FLASH_NOTES = 1000;
export const MAX_FLASHCARDS = 2000;
export const SRS_DAILY_RETENTION_DAYS = 365;
export const FLASHCARDS_PAGE_PATH = 'src/pages/flashcards/index.html';
/** The new-tab dashboard — the "main" extension page the sub-pages link back to */
export const NEWTAB_PAGE_PATH = 'src/pages/newtab/index.html';

/* Research-paper tracker */
export const MAX_PAPERS = 500;
export const PAPERS_PAGE_PATH = 'src/pages/papers/index.html';
/** The in-extension PDF reader; opened as <path>?src=<encoded pdf url> */
export const READER_PAGE_PATH = 'src/pages/reader/index.html';
export const MAX_PDF_ANNOTATIONS = 2000;
export const ANNOTATION_TEXT_MAX_CHARS = 500;
/* Semantic Scholar Graph API — free, unauthenticated (rate-limited). Accepts
   arXiv:<id>, DOI:<doi>, or URL:<url> as the paper reference. */
export const SEMANTIC_SCHOLAR_PAPER_API = 'https://api.semanticscholar.org/graph/v1/paper/';

/* Google Calendar (chrome.identity OAuth; see docs/google-calendar-setup.md) */
export const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
export const CALENDAR_REFRESH_MINUTES = 15;
/** Unforced refreshes (newtab opens) within this window reuse the cache */
export const CALENDAR_REFRESH_THROTTLE_MS = 60_000;

/* Notion meeting notes pull (token/DB configured in Notion sync settings) */
export const MEETING_NOTES_REFRESH_MINUTES = 30;
/** Unforced refreshes (newtab opens) within this window reuse the cache */
export const MEETING_NOTES_THROTTLE_MS = 60_000;

/* Assistant cloud fallback — Gemini API (user-supplied key in settings) */
export const GEMINI_MODEL = 'gemini-3.5-flash';
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
/** Above this many chars of system+input, answers escalate from Nano to cloud */
export const NANO_INPUT_BUDGET_CHARS = 5000;
/** Hard cap on extracted page text sent to any model */
export const PAGE_TEXT_MAX_CHARS = 15000;
/** Hard cap on PDF text sent to the cloud model for the reader's Q&A panel.
 * Larger than PAGE_TEXT_MAX_CHARS — a whole paper, not a single web page. */
export const PDF_QA_CLOUD_MAX_CHARS = 120000;
/** Assistant memory: newest facts win once the store is full */
export const MAX_ASSISTANT_FACTS = 50;
export const FACT_MAX_CHARS = 280;
/** Assistant skills: user-written instruction docs (see types.AssistantSkill) */
export const MAX_ASSISTANT_SKILLS = 20;
export const SKILL_MAX_CHARS = 2000;
/** Prompt budget for injected skills per turn (top 2 within budget) */
export const SKILL_BUDGET_CHARS = 1200;
/** Scheduled automations: caps + per-run proposal budget */
export const MAX_AUTOMATIONS = 10;
export const AUTOMATION_MAX_PROPOSALS = 3;
export const AUTOMATION_DIGEST_MAX_CHARS = 400;
/** Interval automations may not fire more often than this */
export const AUTOMATION_MIN_INTERVAL_MINUTES = 15;
/** Two contexts racing the same automation: second run within this window skips */
export const AUTOMATION_DEBOUNCE_MS = 60_000;
/** Longest tool chain one request may plan (cloud-only feature) */
export const MAX_PLAN_STEPS = 5;

/* "Hey Jarvis" wake word — always-on mic in an offscreen document */
export const OFFSCREEN_PAGE_PATH = 'src/pages/offscreen/index.html';
/** Quiet gap that ends command capture after the wake word. Chrome's
    recognizer already endpoints ~500ms before emitting a final result,
    so this stacks on top of that — keep it short. */
export const WAKE_CAPTURE_SILENCE_MS = 800;
/** Hard cap on one command capture */
export const WAKE_CAPTURE_MAX_MS = 15_000;
/** Wake word said alone: how long the "Yes?" window stays open */
export const WAKE_ACK_TIMEOUT_MS = 5000;
/** Auto-resume if a push-to-talk page died without sending busy:false */
export const WAKE_PTT_FAILSAFE_MS = 60_000;

export const CAPTURE_WINDOW_TASK = { width: 440, height: 180 } as const;
export const CAPTURE_WINDOW_DUMP = { width: 440, height: 520 } as const;

export const ALARMS = {
  refreshFeeds: 'refresh-feeds',
  taskReminders: 'task-reminders',
  sprintEnd: 'sprint-end',
  nudgePrefix: 'nudge|',
  gymReminder: 'gym-reminder',
  gymReminderSnooze: 'gym-reminder-snooze',
  focusPhaseEnd: 'focus-phase-end',
  focusBadgeTick: 'focus-badge-tick',
  notionFlush: 'notion-flush',
  calendarRefresh: 'calendar-refresh',
  meetingNotesRefresh: 'meeting-notes-refresh',
  monitorEvening: 'monitor-evening',
  monitorCalendar: 'monitor-calendar',
  automationPrefix: 'automation|',
} as const;

export const NOTIFICATION_IDS = {
  taskDigest: 'task-digest',
  sprintDone: 'sprint-done',
  nudgePrefix: 'nudge|',
  gymReminder: 'gym-reminder',
  levelUp: 'level-up',
  questComplete: 'quest-complete',
  badgePrefix: 'badge|',
  focusPhase: 'focus-phase',
  bookmarkSaved: 'bookmark-saved',
  streakFreeze: 'streak-freeze',
  chest: 'chest',
  hyperfocus: 'hyperfocus',
  monitorEvening: 'monitor-evening',
  monitorEventPrefix: 'monitor-event|',
  wakeReply: 'wake-reply',
  wakeMicDenied: 'wake-mic-denied',
  automationPrefix: 'automation|',
} as const;

/** Evening check only mentions due flashcards at or above this pile size */
export const MONITOR_CARDS_DUE_MIN = 10;
/** Notify when a calendar event starts within this many minutes */
export const MONITOR_EVENT_WINDOW_MIN = 12;

export const SAMPLE_FEEDS: ReadonlyArray<{ name: string; url: string }> = [
  { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  { name: 'r/programming', url: 'https://www.reddit.com/r/programming/.rss' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  { name: 'CSS Tricks', url: 'https://css-tricks.com/feed/' },
];
