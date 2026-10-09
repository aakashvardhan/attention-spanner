/**
 * Versioning metadata on every user-authored record.
 *
 * This arrived for cloud sync, which is gone, but it did not leave with it:
 * agentRuns.ts reads `updatedAt` to detect a record that changed under a
 * pending agent proposal, and `deletedAt` to detect one that was removed. That
 * is optimistic concurrency, not bookkeeping for a transport.
 *
 * Optional so pre-v6 records still typecheck; the v6 migration backfilled
 * `updatedAt` from createdAt and left `deletedAt` unset.
 */
export interface RecordMeta {
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

export interface ResumeTarget {
  kind: 'article' | 'video';
  url: string;
  title: string;
  /** Reading position fields are optional because each medium uses a different one. */
  scrollY?: number;
  positionSeconds?: number;
}

/** UI color theme; 'system' follows the OS prefers-color-scheme */
export type ThemeSetting = 'light' | 'dark' | 'system';

export interface Settings {
  theme: ThemeSetting;
  /** PDF reader night mode: dark chrome with the pages themselves inverted */
  readerNight: boolean;
  /** Reader focus line: dim everything but the passage being read (key F) */
  readerFocusLine: boolean;
  /** Feed refresh interval in minutes (15–360) */
  refreshInterval: number;
  notificationsEnabled: boolean;
  nudgesEnabled: boolean;
  /** Warn after a long unbroken reading/watching run (HYPERFOCUS_MINUTES) */
  hyperfocusEnabled: boolean;
  /** Domains blocked during focus sessions */
  focusBlocklist: string[];
  focusMinutes: number;
  /** Auto-open Flowtunes in a pinned tab when a focus session starts */
  focusMusicEnabled: boolean;
  /** Semantic Scholar API key for paper metadata lookups; '' = unauthenticated */
  semanticScholarApiKey: string;
  /** Name in the new tab greeting; '' = greet without one */
  displayName: string;
  /** City for the new tab weather, geocoded on first use; '' = no weather */
  weatherLocation: string;
  /** Local Ollama server; every on-device AI call goes here */
  ollamaUrl: string;
  /** Picked from the server's /api/tags; '' = none yet, so generation stays off */
  ollamaChatModel: string;
  ollamaEmbedModel: string;
  /**
   * When public content (RSS, arXiv/DOI papers, YouTube) may go to Claude:
   * never, after a per-request confirm, or whenever the local model cannot
   * take it. Private content never goes, whatever this says (llm/route.ts).
   */
  cloudMode: CloudMode;
  /** User's own Anthropic API key; '' = no cloud */
  claudeKey: string;
  /** Local Laya sidecar (scripts/laya-server); '' = off */
  layaUrl: string;
  /**
   * Topics hidden from the feed card on the new tab: whole words, any case,
   * matched against title, snippet and source name. Read through
   * normalizeTopics, which also survives a hand-edited value.
   */
  mutedTopics: string[];
}

export type CloudMode = 'off' | 'ask' | 'public';

/** Per-feature counters and latency samples. Never leaves the device. */
export interface AiStats {
  /** 'feature.counter' → count, e.g. 'recap.shown' */
  counts: Record<string, number>;
  /** Newest last, capped (AI_STATS_MAX_SAMPLES) */
  latencies: { task: string; target: string; ms: number }[];
  /**
   * A resume waiting to be scored: did the item advance AI_RESUME_ADVANCE
   * points after it was reopened, with or without a recap shown?
   */
  probes: {
    key: string;
    startPercent: number;
    recap: boolean;
    at: number;
    /** A feed pick opened from triage: scored on finishing, not on advancing */
    kind?: 'triage';
  }[];
}

export interface AiCacheEntry {
  text: string;
  target: string;
  model: string;
  at: number;
}

/** Last weather reading, kept so a new tab paints before the network answers. */
export interface WeatherCache {
  /** The settings.weatherLocation this was geocoded from — a change invalidates it */
  query: string;
  /** Resolved place name from the geocoder, which is tidier than what was typed */
  name: string;
  lat: number;
  lon: number;
  /** Always Celsius; the display unit is decided at render */
  tempC: number;
  /** WMO weather code — see weatherLabel */
  code: number;
  fetchedAt: number;
}

/* Flashcards (Anki-style SRS). One authored FlashNote generates N reviewable
   FlashCards (cloze indexes / reversed direction); card ids are deterministic
   `${noteId}#${variant}` so note edits reconcile instead of resetting scheduling. */

/** A deck is dedicated to one purpose — flashcards or research papers. */
export type DeckKind = 'flashcards' | 'papers';

export interface Deck extends RecordMeta {
  id: string;
  name: string;
  createdAt: number;
  /** Decks created before this field default to 'flashcards' (see migrate) */
  kind: DeckKind;
}

export type PaperStatus = 'to-read' | 'reading' | 'read';

export type PaperKind = 'survey' | 'method' | 'benchmark' | 'dataset' | 'position' | 'theory';

export interface Paper extends RecordMeta {
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
  /** Absent on papers filed before it existed, or never set */
  kind?: PaperKind;
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

   Local-only, id-addressable and versioned like every other record. */

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

export interface Annotation extends RecordMeta {
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

/** What Laya read a highlight as, and how sure it was (llm/matrix.ts). */
export interface HighlightRole {
  role: string;
  p: number;
  /** Of the text it was classified from; an edited note re-classifies */
  hash: string;
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

export interface BookmarkGroup extends RecordMeta {
  id: string;
  name: string;
  createdAt: number;
}

export interface BookmarkLink extends RecordMeta {
  id: string;
  url: string;
  title: string;
  /** null renders under "Unsorted" */
  groupId: string | null;
  createdAt: number;
}

/** One local day in the new tab's heatmap (shared/activity.ts). */
/** A parked brain dump (shared/brainDump.ts) */
export interface Dump {
  id: string;
  text: string;
  createdAt: number;
  /** Unset until asked; null when the local model found nothing to act on */
  nextStep?: string | null;
  /** Steps already ticked off, oldest first; a null nextStep after these means the loop is closed */
  done?: string[];
  /** Laya's call, made once: a task ends, a recurring dump gets one step a day for good */
  kind?: 'task' | 'recurring';
  /** When the last step was ticked off; a recurring dump is due again the next local day */
  lastDoneAt?: number;
}

export interface DayActivity {
  /** Distinct papers read that day */
  papers: string[];
  /** Focus sessions that ran to the end; a stopped one does not count */
  focus: number;
}

export interface FocusSession {
  startedAt: number;
  phaseEndsAt: number;
  focusMinutes: number;
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
  /**
   * The player's current chapter title, scraped from the DOM. Decoration only:
   * YouTube owns that class name, most videos have no chapters at all, and an
   * absent chapter must render as absence rather than an invented "Chapter 1".
   */
  chapter?: string;
}

export type AnyProgress = ReadingProgress | VideoProgress;