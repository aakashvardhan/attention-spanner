import type { Annotation, AnnotationDraft } from './types';

export type Message =
  /** The reader page opened (or reloaded) a paper: start or join the reading session */
  | { type: 'READER_OPENED'; title: string }
  /** The blocked page's "Back to your paper" */
  | { type: 'FOCUS_READER' }
  /** Settings: open alphaXiv's login window, then sync */
  | { type: 'ALPHAXIV_SIGN_IN' }
  | { type: 'ALPHAXIV_SIGN_OUT' }
  /** New tab open, or "Sync now" (force) */
  | { type: 'ALPHAXIV_SYNC'; force?: boolean }
  // PDF reader → service worker (single writer keeps progress monotonic)
  | {
      type: 'PAPER_READER_PROGRESS';
      paperId: string;
      pdfUrl: string;
      page: number;
      pageCount: number;
      offset: number;
      leftOff: string;
      /** Reading seconds since the last report */
      activeSecondsDelta: number;
    }
  | { type: 'READER_OPEN_NATIVE'; url: string }
  // Reader annotations (highlights / sticky notes)
  | { type: 'ANNOT_ADD'; draft: AnnotationDraft }
  | { type: 'ANNOT_UPDATE'; id: string; patch: Partial<Pick<Annotation, 'note' | 'color' | 'tag'>> }
  | { type: 'ANNOT_MOVE'; id: string; x: number; y: number }
  | { type: 'ANNOT_DELETE'; id: string };

export interface MessageResponses {
  READER_OPENED: { ok: boolean };
  FOCUS_READER: { ok: boolean };
  ALPHAXIV_SIGN_IN: { ok: boolean; error?: string };
  ALPHAXIV_SIGN_OUT: { ok: boolean };
  ALPHAXIV_SYNC: { ok: boolean; error?: string };
  PAPER_READER_PROGRESS: { ok: boolean; error?: string };
  READER_OPEN_NATIVE: { ok: boolean };
  ANNOT_ADD: { ok: boolean; annotation?: Annotation; error?: string };
  ANNOT_UPDATE: { ok: boolean; error?: string };
  ANNOT_MOVE: { ok: boolean; error?: string };
  ANNOT_DELETE: { ok: boolean; error?: string };
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

export function sendMessage<T extends Message['type']>(
  msg: Extract<Message, { type: T }>,
): Promise<MessageResponses[T]> {
  if (localDispatcher) return localDispatcher(msg) as Promise<MessageResponses[T]>;
  return chrome.runtime.sendMessage(msg);
}
