//! Values shared across the extension.

pub const MAX_PDF_NATIVE_BYPASS: usize = 100;

pub(crate) const DEFAULT_FOCUS_BLOCKLIST: [&str; 7] = [
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
pub(crate) const DAILY_GATE_ALLOW_DNR_ID: i64 = 901;
/// A focus round's one allowed YouTube video (focus_rules::study_video_rule).
pub(crate) const STUDY_VIDEO_DNR_ID: i64 = 902;
pub(crate) const FOCUS_DNR_PRIORITY: i64 = 300;
/// The PDF redirect, then one allow rule per bypassed URL.
pub(crate) const PDF_DNR_ID: i64 = 3000;
pub(crate) const PDF_BYPASS_DNR_ID_BASE: i64 = 3001;

pub const BLOCKED_PAGE_PATH: &str = "src/pages/blocked/index.html";
pub const NEWTAB_PAGE_PATH: &str = "src/pages/newtab/index.html";
pub const PAPERS_PAGE_PATH: &str = "src/pages/papers/index.html";
pub const NOTES_PAGE_PATH: &str = "src/pages/notes/index.html";
pub const LEXICON_PAGE_PATH: &str = "src/pages/lexicon/index.html";
pub const READER_PAGE_PATH: &str = "src/pages/reader/index.html";
pub const DUMPS_PAGE_PATH: &str = "src/pages/dumps/index.html";
pub const SIDEBAR_PAGE_PATH: &str = "src/pages/sidebar/index.html";
pub(crate) const MAX_ANNOTATIONS: usize = 2000;
pub const ANNOTATION_TEXT_MAX_CHARS: usize = 500;

pub(crate) const AI_CACHE_MAX_ENTRIES: usize = 200;
pub const CLAUDE_MODEL_QUICK: &str = "claude-haiku-5-5";

/// Alarms of cut features, cleared by name on install (an alarm outlives its code).
pub const RETIRED_ALARMS: &[&str] = &[
    "daily-brain-dump-midnight",
    "refresh-jobs",
    "task-reminders",
    "sprint-end",
    "gym-reminder",
    "gym-reminder-snooze",
    "calendar-refresh",
    "monitor-evening",
    "monitor-calendar",
    "gmail-triage",
    "refresh-feeds",
    "focus-phase-end",
    "focus-badge-tick",
];
/// Alarm families named per item (one per rule or article): cleared by prefix.
pub const RETIRED_ALARM_PREFIXES: &[&str] = &["automation|", "nudge|"];
/// The alphaXiv library sync.
pub const SYNC_ALARM: &str = "alphaxiv-sync";
