import type {
  Annotation,
  AnnotationDraft,
  BookmarkGroup,
  BookmarkLink,
  Deck,
  DeckKind,
  Paper,
  PaperDraft,
} from './types';
import type { TranscriptSegment } from './youtubeCaptions';

export interface ResumeTarget {
  scrollY: number;
  pageHeight: number;
}

export type Message =
  | { type: 'REFRESH_FEEDS' }
  | {
      type: 'OPEN_ARTICLE';
      url: string;
      feedItemId: string | null;
      resume?: boolean;
      /** false opens the page as itself instead of in the reader — saved links */
      readerView?: boolean;
      /** true opens PDFs as themselves too, skipping the PDF reader — Worth reading */
      original?: boolean;
      /** Same-story items folded into the opened row; marked read with it */
      alsoReadIds?: string[];
    }
  | { type: 'MARK_ALL_READ' }
  | { type: 'VALIDATE_FEED'; url: string }
  | { type: 'START_FOCUS'; focusMinutes: number }
  | { type: 'STOP_FOCUS'; early: boolean }
  | { type: 'ADD_BOOKMARK'; url: string; title: string; groupId: string | null }
  | { type: 'DELETE_BOOKMARK'; id: string }
  | { type: 'MOVE_BOOKMARK'; id: string; groupId: string | null }
  | { type: 'ADD_BOOKMARK_GROUP'; name: string }
  | { type: 'DELETE_BOOKMARK_GROUP'; id: string }
  /* Deck messages kept their FLASH_ prefix when flashcards were cut — papers
     live in decks, and renaming would touch every caller for no behaviour
     change. */
  | { type: 'FLASH_ADD_DECK'; name: string; kind: DeckKind }
  | { type: 'FLASH_DELETE_DECK'; id: string }
  | { type: 'PAPER_ADD'; draft: PaperDraft }
  | { type: 'PAPER_UPDATE'; id: string; patch: Partial<PaperDraft> }
  | { type: 'PAPER_DELETE'; id: string }
  // PDF reader → service worker (single writer keeps progress monotonic)
  | {
      type: 'PAPER_READER_PROGRESS';
      paperId: string;
      pdfUrl: string;
      page: number;
      pageCount: number;
      offset: number;
      leftOff: string;
    }
  | { type: 'READER_OPEN_NATIVE'; url: string }
  // Reader annotations (highlights / sticky notes), PDFs and articles alike
  | { type: 'ANNOT_ADD'; draft: AnnotationDraft }
  | { type: 'ANNOT_UPDATE'; id: string; patch: Partial<Pick<Annotation, 'note' | 'color'>> }
  | { type: 'ANNOT_MOVE'; id: string; x: number; y: number }
  | { type: 'ANNOT_DELETE'; id: string }
  // Content script → service worker
  | { type: 'TRACKER_READY' }
  | {
      type: 'VIDEO_TRACKER_READY';
      videoId: string;
      durationSeconds: number;
      url: string;
      title: string;
      channel: string;
    }
  | {
      type: 'VIDEO_PROGRESS';
      videoId: string;
      positionSeconds: number;
      durationSeconds: number;
      watchedSecondsDelta: number;
      /** True when playback stopped (pause/ended/pagehide/navigation) */
      stopped: boolean;
      title: string;
      channel: string;
      /** Player chapter title; '' when the video has no chapters */
      chapter: string;
    }
  | { type: 'FOCUS_VIDEO_TAB'; videoId: string }
  /** Captions for the new tab's Follow pane. */
  | { type: 'VIDEO_TRANSCRIPT'; videoId: string }
  | {
      type: 'PROGRESS_UPDATE';
      percent: number;
      scrollY: number;
      pageHeight: number;
      activeSecondsDelta: number;
      /** True when this is the flush fired as the page went hidden */
      hidden: boolean;
      /**
       * The document being read, when that isn't the sender's own URL — the
       * in-extension reader renders an article whose tab URL is the reader
       * page. Content scripts omit it and are keyed by their tab as before.
       */
      doc?: { url: string; title: string };
    };

export interface MessageResponses {
  REFRESH_FEEDS: { ok: boolean; itemCount: number; newCount: number; failedCount: number };
  OPEN_ARTICLE: { ok: boolean };
  MARK_ALL_READ: { ok: boolean; count: number };
  VALIDATE_FEED: { ok: boolean; valid: boolean; title: string | null };
  START_FOCUS: { ok: boolean };
  STOP_FOCUS: { ok: boolean };
  ADD_BOOKMARK: { ok: boolean; bookmark: BookmarkLink };
  DELETE_BOOKMARK: { ok: boolean };
  MOVE_BOOKMARK: { ok: boolean };
  ADD_BOOKMARK_GROUP: { ok: boolean; group: BookmarkGroup };
  DELETE_BOOKMARK_GROUP: { ok: boolean };
  FLASH_ADD_DECK: { ok: boolean; deck?: Deck; error?: string };
  FLASH_DELETE_DECK: { ok: boolean; error?: string };
  PAPER_ADD: { ok: boolean; paper?: Paper; error?: string };
  PAPER_UPDATE: { ok: boolean; error?: string };
  PAPER_DELETE: { ok: boolean; error?: string };
  PAPER_READER_PROGRESS: { ok: boolean; error?: string };
  READER_OPEN_NATIVE: { ok: boolean };
  ANNOT_ADD: { ok: boolean; annotation?: Annotation; error?: string };
  ANNOT_UPDATE: { ok: boolean; error?: string };
  ANNOT_MOVE: { ok: boolean; error?: string };
  ANNOT_DELETE: { ok: boolean; error?: string };
  TRACKER_READY: { ok: boolean; resume: ResumeTarget | null };
  PROGRESS_UPDATE: { ok: boolean };
  VIDEO_TRACKER_READY: {
    ok: boolean;
    track: boolean;
    resume: { positionSeconds: number } | null;
  };
  VIDEO_PROGRESS: { ok: boolean };
  FOCUS_VIDEO_TAB: { ok: boolean };
  VIDEO_TRANSCRIPT: { ok: boolean; segments?: TranscriptSegment[]; error?: string };
}

/**
 * In-process dispatcher, registered only by the service worker: runtime
 * messages a context sends to itself never reach its own onMessage listener,
 * so without this the SW couldn't run tools (they all call sendMessage).
 * With it, every tool becomes SW-runnable with zero per-tool changes —
 * pages and the offscreen doc keep the normal runtime path.
 */
let localDispatcher: ((msg: Message) => Promise<unknown>) | null = null;

export function setLocalDispatcher(fn: (msg: Message) => Promise<unknown>): void {
  localDispatcher = fn;
}

/**
 * False once the extension has been reloaded or updated. Content scripts keep
 * running in the page after that, but their chrome.runtime handle is dead and
 * every sendMessage throws — silently, since the callers swallow it. Each
 * content script exposes this over a window global so that a freshly injected
 * replacement can tell a live instance from an orphan it needs to evict.
 */
export function extensionAlive(): boolean {
  try {
    return chrome.runtime?.id !== undefined;
  } catch {
    return false;
  }
}

export function sendMessage<T extends Message['type']>(
  msg: Extract<Message, { type: T }>,
): Promise<MessageResponses[T]> {
  if (localDispatcher) return localDispatcher(msg) as Promise<MessageResponses[T]>;
  return chrome.runtime.sendMessage(msg);
}
