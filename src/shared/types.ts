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

/** UI color theme; 'system' follows the OS prefers-color-scheme (retired in the wood redesign) */
export type ThemeSetting = 'light' | 'dark' | 'paperwhite' | 'system';

export interface Settings {
  theme: ThemeSetting;
  /** PDF reader night mode: dark chrome with the pages themselves inverted */
  readerNight: boolean;
  /** Reader focus line: dim everything but the passage being read (key F) */
  readerFocusLine: boolean;
  /** Domains blocked while a reader tab is open */
  focusBlocklist: string[];
  /** User's own Anthropic API key: Haiku writes questions, grades and definitions; '' = off */
  claudeKey: string;
}

export interface AiCacheEntry {
  text: string;
  target: string;
  model: string;
  at: number;
}

/** An alphaXiv folder (bookmark collection). alphaXiv is the master copy; each folder is a shelf. */
export interface Folder {
  id: string;
  name: string;
  /** 'default-to-read' | 'default-reading' | 'default-completed' | 'default-publications' | custom */
  type: string;
}

/**
 * A paper on the shelf: alphaXiv's record mirrored, plus the reading state only
 * this extension keeps (progress, where you stopped).
 */
export interface Paper extends RecordMeta {
  /** arXiv id ('2406.09246'): alphaXiv's universal_paper_id */
  id: string;
  title: string;
  /** Comma-joined author names; '' until known */
  authors: string;
  year: number | null;
  /** https://arxiv.org/abs/<id>; "Open paper" and the PDF helpers derive from it */
  url: string;
  /** alphaXiv folders this paper sits in (a paper can be in several) */
  folderIds: string[];
  /** 0-100; ratcheted by the PDF reader */
  progressPercent: number;
  /** "Where I stopped", e.g. "Section 4.2: ablations" */
  leftOff: string;
  /** Set by the in-extension PDF reader; absent until the paper is opened there */
  pdf?: {
    /** The PDF URL the reader loaded */
    url: string;
    /** 1-based page the user was last on */
    page: number;
    pageCount: number;
    /** Scroll position within `page`, 0-1 */
    offset: number;
  };
  addedAt: number;
  updatedAt: number;
  lastReadAt: number | null;
}

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
  tag?: HighlightTag;
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

/** A brain dump waiting for first-time vault setup; after that every dump is a LockedDump */
export interface Dump {
  id: string;
  text: string;
  createdAt: number;
}

/** AES-GCM ciphertext, base64; `salt` is set when the key came from a secret via PBKDF2 */
export interface Sealed {
  salt?: string;
  iv: string;
  data: string;
}

/** The dump vault: anyone can seal with the public key; the private key opens only with a secret */
export interface Vault {
  publicKey: JsonWebKey;
  byPassphrase: Sealed;
  byRecovery: Sealed;
}

/** A sealed dump. `createdAt` stays clear for ordering and the count; the words never do. */
export interface LockedDump {
  id: string;
  createdAt: number;
  wrappedKey: string;
  iv: string;
  data: string;
}

/** What a locked dump holds once opened */
export interface DumpEntry {
  text: string;
  bullets: string[];
  createdAt: number;
}

/** One local day in the new tab's heatmap (shared/activity.ts). */
export interface DayActivity {
  /** Distinct papers read that day */
  papers: string[];
  /** Focus rounds that ran to the end; a stopped one does not count */
  focus: number;
  /** Minutes clocked in, logged at clock out; absent on days before it shipped */
  clocked?: number;
}

/**
 * A reading session: distracting sites are blocked while at least one reader
 * tab is open. It ends when the last reader tab closes or leaves the reader.
 */
export interface FocusSession {
  startedAt: number;
  /** Open reader tabs; the session ends when this empties */
  tabIds: number[];
  /** The paper being read, quoted on the blocked page */
  title: string;
}

export type HighlightTag = 'claim' | 'evidence' | 'doubt';
