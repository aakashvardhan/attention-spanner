/** PDFs the user sent to Chrome's own viewer; session-scoped (pdfIntercept.ts) */
export const MAX_PDF_NATIVE_BYPASS = 100;

export const DEFAULT_FOCUS_BLOCKLIST = [
  'mail.google.com',
  'linkedin.com',
  'netflix.com',
  'amazon.com',
  'hulu.com',
  'hbomax.com',
  'max.com',
];
/** Session-rule range reserved for the reading-session redirects. */
export const FOCUS_DNR_ID_BASE = 1000;
export const FOCUS_DNR_ID_LIMIT = 2000;
/** The retired daily gate's rules. The feature is gone; these ids survive so
 *  removeLegacyDailyGateRule can still sweep profiles that carry them. */
export const DAILY_GATE_DNR_ID = 900;
export const DAILY_GATE_ALLOW_DNR_ID = 901;
export const FOCUS_DNR_PRIORITY = 300;
/** Session rules sending PDF navigations to the reader: the redirect, then one allow per bypassed URL. */
export const PDF_DNR_ID = 3000;
export const PDF_BYPASS_DNR_ID_BASE = 3001;
export const BLOCKED_PAGE_PATH = 'src/pages/blocked/index.html';

/** The new-tab dashboard: the "main" extension page the sub-pages link back to */
export const NEWTAB_PAGE_PATH = 'src/pages/newtab/index.html';
export const PAPERS_PAGE_PATH = 'src/pages/papers/index.html';
/** The in-extension PDF reader; opened as <path>?src=<encoded pdf url> */
export const READER_PAGE_PATH = 'src/pages/reader/index.html';
export const MAX_ANNOTATIONS = 2000;
export const ANNOTATION_TEXT_MAX_CHARS = 500;

export const AI_CACHE_MAX_ENTRIES = 200;
export const CLAUDE_MODELS = {
  quick: 'claude-haiku-5-5',
  deep: 'claude-sonnet-5-5',
} as const;
