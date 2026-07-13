export const ACCENT_COLOR = '#ff6b35';

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
/* Semantic Scholar Graph API — free, unauthenticated (rate-limited). Accepts
   arXiv:<id>, DOI:<doi>, or URL:<url> as the paper reference. */
export const SEMANTIC_SCHOLAR_PAPER_API = 'https://api.semanticscholar.org/graph/v1/paper/';

/* Assistant cloud fallback — Gemini API (user-supplied key in settings) */
export const GEMINI_MODEL = 'gemini-3.5-flash';
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
/** Above this many chars of system+input, answers escalate from Nano to cloud */
export const NANO_INPUT_BUDGET_CHARS = 5000;
/** Hard cap on extracted page text sent to any model */
export const PAGE_TEXT_MAX_CHARS = 15000;

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
} as const;

export const SAMPLE_FEEDS: ReadonlyArray<{ name: string; url: string }> = [
  { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  { name: 'r/programming', url: 'https://www.reddit.com/r/programming/.rss' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  { name: 'CSS Tricks', url: 'https://css-tricks.com/feed/' },
];
