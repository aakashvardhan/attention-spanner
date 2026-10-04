export const ACCENT_COLOR = '#0ea5e9';

export const FETCH_TIMEOUT_MS = 15000;

/* Come-back nudges. These were settings; nobody retunes them, and the ADHD-
   tuned values are the point of the feature. `nudgesEnabled` still switches
   the whole thing off. */
/** Minutes away from a partially-read article before a nudge fires */
export const NUDGE_DELAY_MINUTES = 3;
/** Per-article cooldown between nudges */
export const NUDGE_COOLDOWN_MINUTES = 60;
export const NUDGE_MAX_PER_ARTICLE = 2;
/** Only auto-track YouTube videos at least this long */
export const VIDEO_MIN_MINUTES = 15;
/**
 * How long a video keeps its "watching now" badge after the last heartbeat.
 * The tracker beats every 5s while playing, so this tolerates two misses
 * before a tab that died without a stop flush goes quiet on the dashboard.
 */
export const VIDEO_WATCHING_STALE_MS = 15_000;
/** Unbroken engagement before the hyperfocus break nudge (hyperfocusEnabled gates it) */
export const HYPERFOCUS_MINUTES = 90;

export const MAX_READ_ITEMS = 500;
export const MAX_CACHED_ITEMS = 300;
/** PDFs the user sent to Chrome's own viewer; session-scoped (pdfIntercept.ts) */
export const MAX_PDF_NATIVE_BYPASS = 100;

/** Thresholds for "Continue where I left off" — either one qualifies */
export const CONTINUE_MIN_PERCENT = 5;
export const CONTINUE_MIN_SECONDS = 30;

export const DEFAULT_FOCUS_BLOCKLIST = [
  'mail.google.com',
  'linkedin.com',
  'netflix.com',
  'amazon.com',
  'hulu.com',
  'hbomax.com',
  'max.com',
];
/** Session-rule range reserved for Focus redirects. */
export const FOCUS_DNR_ID_BASE = 1000;
export const FOCUS_DNR_ID_LIMIT = 2000;
/** The retired daily gate's rules. The feature is gone; these ids survive so
 *  removeLegacyDailyGateRule can still sweep profiles that carry them. */
export const DAILY_GATE_DNR_ID = 900;
export const DAILY_GATE_ALLOW_DNR_ID = 901;
export const FOCUS_DNR_PRIORITY = 300;
export const BLOCKED_PAGE_PATH = 'src/pages/blocked/index.html';
export const HOLD_TO_QUIT_MS = 5000;
export const FLOWTUNES_URL = 'https://www.flowtunes.app/';
export const MAX_BOOKMARKS = 200;

/** The new-tab dashboard — the "main" extension page the sub-pages link back to */
export const NEWTAB_PAGE_PATH = 'src/pages/newtab/index.html';

/* Research-paper tracker. Papers live in decks, which is why MAX_DECKS
   outlived the flashcards feature that introduced it. */
export const MAX_DECKS = 50;
export const MAX_PAPERS = 500;
export const PAPERS_PAGE_PATH = 'src/pages/papers/index.html';
/** The in-extension PDF reader; opened as <path>?src=<encoded pdf url> */
export const READER_PAGE_PATH = 'src/pages/reader/index.html';
export const MAX_ANNOTATIONS = 2000;
export const ANNOTATION_TEXT_MAX_CHARS = 500;

/* Research-paper metadata lookups. Semantic Scholar Graph API — free and
   unauthenticated (rate-limited). Accepts arXiv:<id>, DOI:<doi>, or URL:<url>
   as the paper reference. */
export const SEMANTIC_SCHOLAR_PAPER_API = 'https://api.semanticscholar.org/graph/v1/paper/';

export const ALARMS = {
  refreshFeeds: 'refresh-feeds',
  nudgePrefix: 'nudge|',
  focusPhaseEnd: 'focus-phase-end',
  focusBadgeTick: 'focus-badge-tick',
} as const;

export const NOTIFICATION_IDS = {
  nudgePrefix: 'nudge|',
  focusPhase: 'focus-phase',
  bookmarkSaved: 'bookmark-saved',
  hyperfocus: 'hyperfocus',
  focusDrift: 'focus-drift',
} as const;

export const SAMPLE_FEEDS: ReadonlyArray<{ name: string; url: string }> = [
  { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  { name: 'r/programming', url: 'https://www.reddit.com/r/programming/.rss' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  { name: 'CSS Tricks', url: 'https://css-tricks.com/feed/' },
];

/* Local AI (src/shared/llm). */
/** num_ctx sent to Ollama. Its own default is small, and silently truncates. */
export const OLLAMA_NUM_CTX = 8192;
/**
 * Input the local model is trusted with in one call. ~3.5 chars per token,
 * minus room for the system prompt and the answer.
 */
export const LOCAL_CONTEXT_CHARS = 20_000;
export const AI_CACHE_MAX_ENTRIES = 200;
export const AI_STATS_MAX_SAMPLES = 50;
/** Percentage points a resumed item must gain to count as "picked back up" */
export const AI_RESUME_ADVANCE = 15;
/* Laya probability floors (src/shared/llm/laya.ts). Calibration knobs, not
   laws: below one, a suggestion stays quiet rather than risk being wrong.
   Laya is cautious — DDPM went to the obvious deck at only 0.62 of 3 — so a
   prefill the user reviews before saving can sit lower than a nudge. */
export const LAYA_PREFILL_MIN = 0.55;
export const LAYA_ROLE_MIN = 0.5;
export const LAYA_DRIFT_MIN = 0.85;
export const LAYA_URL_DEFAULT = 'http://localhost:11435';
export const CLAUDE_MODELS = {
  quick: 'claude-haiku-4-5',
  deep: 'claude-sonnet-5-5',
} as const;
