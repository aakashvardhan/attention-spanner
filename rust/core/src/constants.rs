//! Values shared across the extension (src/shared/constants.ts).

pub const MAX_PDF_NATIVE_BYPASS: usize = 100;

pub const DEFAULT_FOCUS_BLOCKLIST: [&str; 7] = [
    "mail.google.com",
    "linkedin.com",
    "netflix.com",
    "amazon.com",
    "hulu.com",
    "hbomax.com",
    "max.com",
];
/// Session-rule range reserved for the reading-session redirects.
pub const FOCUS_DNR_ID_BASE: i64 = 1000;
pub const FOCUS_DNR_ID_LIMIT: i64 = 2000;
/// The retired daily gate's rules, still swept from old profiles.
pub const DAILY_GATE_DNR_ID: i64 = 900;
pub const DAILY_GATE_ALLOW_DNR_ID: i64 = 901;
pub const FOCUS_DNR_PRIORITY: i64 = 300;
/// The PDF redirect, then one allow rule per bypassed URL.
pub const PDF_DNR_ID: i64 = 3000;
pub const PDF_BYPASS_DNR_ID_BASE: i64 = 3001;

pub const BLOCKED_PAGE_PATH: &str = "src/pages/blocked/index.html";
pub const NEWTAB_PAGE_PATH: &str = "src/pages/newtab/index.html";
pub const PAPERS_PAGE_PATH: &str = "src/pages/papers/index.html";
pub const READER_PAGE_PATH: &str = "src/pages/reader/index.html";
pub const MAX_ANNOTATIONS: usize = 2000;
pub const ANNOTATION_TEXT_MAX_CHARS: usize = 500;

pub const AI_CACHE_MAX_ENTRIES: usize = 200;
pub const CLAUDE_MODEL_QUICK: &str = "claude-haiku-5-5";
pub const CLAUDE_MODEL_DEEP: &str = "claude-sonnet-5-5";
