export const ACCENT_COLOR = '#0ea5e9';

export const FETCH_TIMEOUT_MS = 15000;
export const CACHE_TTL_MS = 5 * 60 * 1000;

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
/** Local 'HH:MM' bounds where proactive nudges stay silent (wraps overnight) */
export const QUIET_HOURS_START = '22:00';
export const QUIET_HOURS_END = '08:00';

export const MAX_READ_ITEMS = 500;
export const MAX_CACHED_ITEMS = 300;
export const MAX_LIST_ITEMS = 50;
/** PDFs the user sent to Chrome's own viewer; session-scoped (pdfIntercept.ts) */
export const MAX_PDF_NATIVE_BYPASS = 100;

/** Thresholds for "Continue where I left off" — either one qualifies */
export const CONTINUE_MIN_PERCENT = 5;
export const CONTINUE_MIN_SECONDS = 30;
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
/** Session-rule range reserved for Focus redirects. */
export const FOCUS_DNR_ID_BASE = 1000;
export const FOCUS_DNR_ID_LIMIT = 2000;
/** Persistent daily redirect + session-scoped daily unlock rule. */
export const DAILY_GATE_DNR_ID = 900;
export const DAILY_GATE_ALLOW_DNR_ID = 901;
export const DAILY_GATE_REDIRECT_PRIORITY = 100;
export const DAILY_GATE_ALLOW_PRIORITY = 200;
export const FOCUS_DNR_PRIORITY = 300;
export const DAILY_BRAIN_DUMP_MIN_VISIBLE_CHARS = 20;
export const BLOCKED_PAGE_PATH = 'src/pages/blocked/index.html';
export const DAILY_GATE_PAGE_PATH = 'src/pages/daily-gate/index.html';
export const HOLD_TO_QUIT_MS = 5000;
export const FLOWTUNES_URL = 'https://www.flowtunes.app/';
export const MAX_BOOKMARKS = 200;

/* Flashcards. Caps keep chrome.storage.local well under quota (no
   unlimitedStorage permission yet — add it if decks ever need to grow). */
export const MAX_DECKS = 50;
export const MAX_FLASH_NOTES = 1000;
export const MAX_FLASHCARDS = 2000;
export const SRS_DAILY_RETENTION_DAYS = 365;
/** The new-tab dashboard — the "main" extension page the sub-pages link back to */
export const NEWTAB_PAGE_PATH = 'src/pages/newtab/index.html';

/* Research-paper tracker */
export const MAX_PAPERS = 500;
export const PAPERS_PAGE_PATH = 'src/pages/papers/index.html';
/** The in-extension PDF reader; opened as <path>?src=<encoded pdf url> */
export const READER_PAGE_PATH = 'src/pages/reader/index.html';
export const MAX_ANNOTATIONS = 2000;
export const ANNOTATION_TEXT_MAX_CHARS = 500;

/* Knowledge graph. Article and video nodes are the only ones stored on their
   own account — the rest mirror durable records and are pruned with them. */
/** Hard cap on stored nodes; only article/video nodes are ever evicted */
export const MAX_GRAPH_NODES = 2000;
/** How many nodes a single layout draws, picked by degree then recency */
export const GRAPH_RENDER_CAP = 400;
/** Collapses a 5s tracker heartbeat into at most one node write per window */
export const GRAPH_TOUCH_THROTTLE_MS = 5 * 60 * 1000;
/** An edge below this summed weight is not worth drawing */
export const GRAPH_EDGE_MIN_WEIGHT = 0.3;
/** Keep an edge if it ranks this high for *either* endpoint (mutual-kNN union) */
export const GRAPH_TOP_K = 6;
export const MAX_GRAPH_EDGES = 2500;
/** A domain on more than this many nodes stops implying a relationship */
export const GRAPH_HUB_DOMAIN_NODES = 8;
/** Topic labels kept per node; past three the clique math compounds */
export const GRAPH_TAGS_PER_NODE = 3;
/** Nodes labelled per model call — ~600 tokens of titles */
export const GRAPH_TAG_BATCH = 20;
/** Bounds one press of "Sort into topics" to ~240 nodes rather than the whole graph */
export const GRAPH_TAG_MAX_BATCHES = 12;
/** Controlled vocabulary carried in every batch prompt — this is what makes
    independently-labelled batches converge on one spelling of a topic */
export const GRAPH_TAG_VOCAB_PROMPT_MAX = 60;
/** A topic on more than this many nodes is a shelf, not a relationship */
export const GRAPH_HUB_TAG_NODES = 12;
/** Weight a shared topic decays to at the hub cap; below GRAPH_EDGE_MIN_WEIGHT
    on purpose, so a broad topic only counts when it stacks with another reason */
export const GRAPH_TAG_MIN_WEIGHT = 0.15;
/** Topics offered in the Show menu, most-used first */
export const GRAPH_TOPIC_MENU_MAX = 30;
/** Neighbourhoods the map is divided into. More than this and the named
    regions stop being scannable — it is the hairball again, with labels. */
export const GRAPH_CLUSTER_MAX = 8;
/** Layout-space gap between neighbourhood centres, scaled by cluster size */
export const GRAPH_CLUSTER_SPACING = 130;

/* "What links here" — the reverse citation index over documents actually read.
   Built from bibliographies the reader already parses, so it costs no network
   and works offline. */
/** Reference keys kept per document; covers a normal bibliography without
    spending 16 KB on a 400-entry survey paper */
export const MAX_DOC_REF_KEYS = 60;
/** Documents in the reverse index — ~600 KB, and past this the corpus is older
    than the reading it describes */
export const MAX_INDEXED_DOCS = 300;

/* Citation expansion — papers around the library that the user does not have.
   Sources are tried cheapest first (see shared/citationSources.ts). */
/** A curated reference list is typically 30–80; 100 gets essentially all of it */
export const SEMANTIC_SCHOLAR_REFS_LIMIT = 100;
/** Citations are unbounded; 50 is more than a 400-node canvas can carry */
export const SEMANTIC_SCHOLAR_CITES_LIMIT = 50;
/** The unauthenticated pool is ~1 rps and shared with every other client */
export const SEMANTIC_SCHOLAR_MIN_INTERVAL_MS = 1100;
export const OPENALEX_API = 'https://api.openalex.org';
/** OpenAlex allows ~100k/day; the gate is politeness, not survival */
export const OPENALEX_MIN_INTERVAL_MS = 200;
/** One batched hydration request — a fallback needing two round-trips isn't one */
export const OPENALEX_HYDRATE_MAX = 50;
/** The DataCite DOI arXiv mints per paper, so an arXiv id resolves on OpenAlex
    without a title search — which could silently return a different paper */
export const ARXIV_DOI_PREFIX = '10.48550/arXiv.';

/* Resolving a saved page to one canonical work (see shared/workResolve.ts).
   Verified 2026-07-28 against developers.openalex.org: keys became mandatory on
   13 Feb 2026 and the `mailto` polite pool is retired, but singleton lookups
   (`/works/doi:…`) are free and unlimited on every tier — so resolving by an
   exact identifier costs nothing at all, with or without a key. A title search
   is the one expensive call: $1 per 1,000 against a $0.10/day budget with no
   key, ten times that with a free one. Hence the opt-out below. */
/**
 * Dice overlap a title-search hit must reach before it is believed.
 *
 * Not a guess. OpenAlex ranks `title.search` by relevance and will happily
 * return a *different* paper at position one: measured, "diffusion models for
 * inpainting" returns "RePaint: Inpainting using Denoising Diffusion
 * Probabilistic Models" first, which scores 0.55 — while a genuine title match
 * scores 1.0. Anywhere in between is a coin flip, and a wrong citation edge is
 * unfalsifiable once drawn, so the gate sits well above the trap.
 */
export const OPENALEX_TITLE_MATCH_MIN = 0.85;
/** Ranked candidates pulled before the similarity gate chooses among them */
export const OPENALEX_TITLE_CANDIDATES = 5;

/* Papers a recording names (see shared/paperMentions.ts). */
/** Enough of a transcript segment to read as a quotation and see the reference
    in context; past this it stops being evidence and becomes a wall of text */
export const MENTION_EVIDENCE_CHARS = 240;
/** A reference list never changes; this makes re-expanding free and idempotent */
export const CITATION_EXPANSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Four full expansions — as much borrowed context as a 400-node canvas carries */
export const MAX_GRAPH_EXTERNALS = 600;
/** Exactly one full expansion, so a single expansion always renders whole */
export const GRAPH_EXTERNAL_RENDER_CAP = 150;
/** Fixed and degree-independent: these are context, not content */
export const GRAPH_EXTERNAL_RADIUS = 7;
/** Distinct papers of your own that must cite a work before it is worth
    surfacing. Two is a coincidence between deck-mates; three is a pattern */
export const GRAPH_QUEUE_MIN_OWNERS = 3;
/** A promoted ghost is drawn nearer a real node — it is a recommendation now,
    not background context */
export const GRAPH_QUEUE_RADIUS = 11;

/* Your own writing in the graph — notes, highlights, and the links between them. */
/** A highlight earns a node once it carries a note or a substantial quote;
    every yellow swipe becoming one buries the graph in confetti */
export const HIGHLIGHT_NODE_MIN_CHARS = 120;
export const MAX_LINKS_PER_NOTE = 20;
/** Below this, a title matches nearly every note ever written ("Attention") */
export const MENTION_MIN_TITLE_CHARS = 16;
/** So one long note cannot connect itself to everything */
export const MAX_MENTIONS_PER_NOTE = 5;
/** The user saying "these belong together" — the same tier as a deck */
export const GRAPH_WEIGHT_LINK = 1;
/** A guess worth surfacing, not worth drawing on its own */
export const GRAPH_WEIGHT_MENTION = 0.3;
/** Titles offered when typing `[[` — a list you scan, not one you search */
export const LINK_SUGGESTIONS = 6;
/** Nodes the graph publishes for the assistant to read: ~60 short entries is
    about 900 tokens, affordable inside a turn alongside the data context */
export const GRAPH_DIGEST_MAX_NODES = 60;
/** How often an open graph page says it is still there */
export const GRAPH_VISIBLE_HEARTBEAT_MS = 15_000;
/** Silence for longer than this means the page is gone. Comfortably more than
    two heartbeats, so a throttled background tab is not mistaken for a closed one. */
export const GRAPH_VISIBLE_STALE_MS = 45_000;
/* Semantic Scholar Graph API — free, unauthenticated (rate-limited). Accepts
   arXiv:<id>, DOI:<doi>, or URL:<url> as the paper reference. */
export const SEMANTIC_SCHOLAR_PAPER_API = 'https://api.semanticscholar.org/graph/v1/paper/';

/** MCP revision this client speaks; sent as MCP-Protocol-Version. */
/** Tool calls run AI models server-side — discovery can take a while. */
/** Refresh an access token this long before it actually expires. */
/** The only Origin alphaXiv's auth server trusts on its oauth2 endpoints — its
    own web app's (see alphaxivAuth.ts). */
/** Rewrites the Origin header (see alphaxivAuth.ts). Kept outside the reserved
    daily-gate and Focus rule IDs so access-rule reconciliation never removes it. */

/* Google Calendar. The OAuth client belongs to the user, not to this build:
   authorization code + PKCE through launchWebAuthFlow, with the id and secret
   pasted in Settings (see docs/google-calendar-setup.md). */
export const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** Read/write events, plus openid+email only to name the account in Settings. */
export const CALENDAR_SCOPE = 'openid email https://www.googleapis.com/auth/calendar.events';
/** Refresh an access token this long before it actually expires. */
export const CALENDAR_EXPIRY_SKEW_MS = 60_000;
/**
 * Gmail: read the inbox, and archive/label what the user confirms. No send
 * and no compose scope — Jarvis never writes mail in the user's name.
 * `openid email` is what names the connected account in Settings.
 */
export const GMAIL_SCOPE =
  'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify';
export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** Unread messages pulled per account per run — a triage list, not an inbox */
export const GMAIL_MAX_MESSAGES = 25;
/** Skip a triage that ran within this window (an alarm racing a manual refresh) */
export const GMAIL_TRIAGE_DEBOUNCE_MS = 60_000;
export const CALENDAR_REFRESH_MINUTES = 15;
/** Unforced refreshes (newtab opens) within this window reuse the cache */
export const CALENDAR_REFRESH_THROTTLE_MS = 60_000;

/* Assistant cloud fallback — Gemini API (user-supplied key in settings) */
export const GEMINI_MODEL = 'gemini-3.5-flash';
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/* Assistant cloud fallback — Anthropic Claude (the other selectable provider) */
export const ANTHROPIC_MODEL = 'claude-haiku-4-5';
export const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
/** Max output tokens for the Claude provider (the Messages API requires it) */
export const ANTHROPIC_MAX_TOKENS = 4096;
/** Generous: a cold local model pays a one-time load of several GB into RAM
 *  before it emits a first token, which the cloud providers never do. */
/** Liveness probe. Short on purpose — a dead localhost must fail fast enough
 *  that the turn falls through to another provider instead of stalling. */

/** Above this many chars of system+input, answers escalate from Nano to cloud */
export const NANO_INPUT_BUDGET_CHARS = 5000;
/** Hard cap on extracted page text sent to any model */
export const PAGE_TEXT_MAX_CHARS = 15000;
/** Hard cap on PDF text sent to the cloud model for the reader's Q&A panel.
 * Larger than PAGE_TEXT_MAX_CHARS — a whole paper, not a single web page. */
export const PDF_QA_CLOUD_MAX_CHARS = 120000;
/* Vision during recordings: sampled tab frames described by Gemini.
 * The detector looks for a "settled slide": changed since the last frame we
 * SENT, but no longer changing sample-to-sample — that second gate is what
 * keeps a playing video from being described three times a minute. */
export const VISION_FRAME_SAMPLE_MS = 2_000;
/** Mean absolute luma delta (0..1) vs the last SENT frame — "meaningfully new" */
export const VISION_DIFF_THRESHOLD = 0.04;
/** Delta vs the PREVIOUS sample below this — "stopped moving" */
export const VISION_SETTLE_THRESHOLD = 0.02;
/** Cost floor between Gemini describe calls, whatever the detector thinks */
export const VISION_MIN_SEND_GAP_MS = 20_000;
/** Comparison grid: 16:9 at postage-stamp size is plenty to spot a slide flip */
export const VISION_GRID_W = 48;
export const VISION_GRID_H = 27;
/** Frames sent to Gemini: downscaled and recompressed, ~60-120 KB each */
export const VISION_FRAME_MAX_WIDTH = 960;
export const VISION_FRAME_JPEG_QUALITY = 0.7;
export const VISION_DESC_MAX_CHARS = 600;
export const VISION_DESCRIBE_TIMEOUT_MS = 30_000;
/** Jarvis page-vision screenshots (captureVisibleTab), same spirit */
export const SCREENSHOT_MAX_WIDTH = 1024;

/* Live mode: speech-gated segment rotation, so a transcript fills in during the
 * meeting instead of five minutes after it. The detector watches loudness on the
 * recorded stream and cuts at a pause, which does two jobs at once — it puts
 * segment boundaries on sentence boundaries rather than on a clock, and it tells
 * us which segments held no speech at all so those can skip transcription
 * entirely. Silence is the single largest avoidable cost in a recording. */
/** How often the analyser is sampled. Matches Pluely's 1024-frame hop at 48kHz. */
export const VAD_POLL_MS = 20;
/** RMS above this counts as speech. Borrowed from Pluely and NOT yet measured
 *  against tab audio, which is cleaner than a desktop mic — see the plan's Risks. */
export const VAD_RMS_THRESHOLD = 0.012;
/** Peak above this within a hop also counts, catching consonants RMS smooths away */
export const VAD_PEAK_THRESHOLD = 0.035;
/** Quiet for this long = the speaker finished a thought; a candidate cut point */
export const VAD_SILENCE_MS = 1_000;
/** Below this much speech in a segment, drop it without transcribing */
export const VAD_MIN_SPEECH_MS = 600;
/** Don't cut before this much audio: one Gemini call per utterance would be
 *  hundreds an hour, so short utterances accumulate into one segment. */
export const LIVE_SEGMENT_MIN_MS = 8_000;
/** Hard ceiling, so a continuously-loud room still produces segments */
export const LIVE_SEGMENT_MAX_MS = 30_000;
/** Trailing transcript sent with a live answer. A live question is about what
 *  is being said now; a longer window is mostly a larger bill. */
export const LIVE_WINDOW_SEC = 180;
/** Live answers are read at a glance mid-meeting, not studied */
export const LIVE_ANSWER_MAX_CHARS = 700;
export const LIVE_ANSWER_TIMEOUT_MS = 30_000;
/** Assistant memory: newest facts win once the store is full */
export const MAX_ASSISTANT_FACTS = 50;
export const FACT_MAX_CHARS = 280;
/**
 * Assistant profile: the always-loaded "about me" block. Small on purpose —
 * it is prepended ahead of MAX_CONTEXT_CHARS, so every character it spends is
 * one the live data snapshot does not get.
 */
export const PROFILE_MAX_CHARS = 800;
/** Journal: days kept, and per-day/per-entry caps that bound the stored blob */
export const JOURNAL_MAX_DAYS = 60;
export const JOURNAL_MAX_ENTRIES_PER_DAY = 40;
export const JOURNAL_ENTRY_MAX_CHARS = 280;
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

/* The ReAct loop's budgets. Every one of these is a hard stop that degrades to
   a partial answer, never an error: the loop spends the user's money and wall
   clock on their behalf, so each dimension gets its own ceiling. */
export const REACT_MAX_ITERATIONS = 6;
/** Total tool calls across all iterations — a model may request several per turn */
export const REACT_MAX_TOOL_CALLS = 8;
/** Calls that cost network quota or a third-party model run (alphaXiv, catch_me_up) */
export const REACT_MAX_COSTLY_CALLS = 2;
/** Mutations batched into one confirm chip; matches MAX_PLAN_STEPS so the chip
    renders exactly like today's plan chip */
export const REACT_MAX_STAGED_MUTATIONS = MAX_PLAN_STEPS;
/** Wall clock for the WHOLE loop. Six iterations against a 60s provider timeout
    is six minutes; this is the constant that actually bounds a runaway turn. */
export const REACT_DEADLINE_MS = 60_000;
/** One observation, after truncation */
export const REACT_OBSERVATION_MAX_CHARS = 2_000;
/** All observations together; older ones elide rather than push out the newest */
export const REACT_SCRATCHPAD_MAX_CHARS = 12_000;
/** Repeated calls / no-new-information rounds before escalating a tier */
export const REACT_STALL_LIMIT = 2;
/** Tier escalations per turn (the chain is at most three deep anyway) */
export const REACT_MAX_ESCALATIONS = 1;
/** Tool errors fed back as observations before that tool stops being offered */
export const REACT_MAX_TOOL_ERRORS = 3;
/** Consecutive failures on ONE tool before it is dropped for the rest of the turn */
export const REACT_TOOL_ERROR_DROP = 2;
/** draft -> critique -> revise rounds; 0 disables the critic entirely */
export const REACT_MAX_REFINE_ROUNDS = 2;
/** Below this length an answer skips the critic — "You have 3 open tasks."
    must not cost two extra cloud calls to double-check */
export const REACT_REFINE_MIN_CHARS = 200;
/** Explicit "do I have enough to answer" calls; 0 disables the check */
export const REACT_MAX_SUFFICIENCY_CHECKS = 2;

/* "Hey Jarvis" wake word — always-on mic in an offscreen document */
export const OFFSCREEN_PAGE_PATH = 'src/pages/offscreen/index.html';

/* On-device wake word (openWakeWord pipeline; see shared/ai/wakeDetector.ts).
   These are not tunable preferences — the first five are fixed by the shapes
   the pretrained models were exported with, and changing one makes the graph
   refuse to run. Only the last two are ours to pick. */

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
  dailyBrainDumpMidnight: 'daily-brain-dump-midnight',
  calendarRefresh: 'calendar-refresh',
  monitorEvening: 'monitor-evening',
  monitorCalendar: 'monitor-calendar',
  gmailTriage: 'gmail-triage',
  automationPrefix: 'automation|',
} as const;

export const NOTIFICATION_IDS = {
  taskDigest: 'task-digest',
  sprintDone: 'sprint-done',
  nudgePrefix: 'nudge|',
  gymReminder: 'gym-reminder',
  badgePrefix: 'badge|',
  focusPhase: 'focus-phase',
  bookmarkSaved: 'bookmark-saved',
  streakFreeze: 'streak-freeze',
  chest: 'chest',
  hyperfocus: 'hyperfocus',
  monitorEvening: 'monitor-evening',
  monitorEventPrefix: 'monitor-event|',
  automationPrefix: 'automation|',
  gmailTriage: 'gmail-triage',
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
