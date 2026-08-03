import type { CalendarEvent } from './calendar';
import type { AssistantTurn } from './ai/assistantTypes';
import type { DocCitations } from './docCitations';
import type { LiveMode, LivePace } from './live';
import type {
  AgentProposal,
  Annotation,
  AnnotationDraft,
  AssistantAutomation,
  AssistantFact,
  AssistantSkill,
  AutomationSchedule,
  BookmarkGroup,
  BookmarkLink,
  BrainDumpNote,
  DayPlan,
  Deck,
  DeckKind,
  JournalEntry,
  Paper,
  PaperDraft,
  Task,
} from './types';

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
    }
  | { type: 'ADD_TASK'; text: string; source: Task['source'] }
  | { type: 'TOGGLE_TASK'; id: string }
  | { type: 'DELETE_TASK'; id: string }
  | { type: 'EDIT_TASK'; id: string; text: string }
  | { type: 'MOVE_TASK'; id: string; toIndex: number }
  | { type: 'MARK_ALL_READ' }
  | { type: 'VALIDATE_FEED'; url: string }
  | { type: 'SNOOZE_TASK'; id: string; minutes: number }
  | { type: 'START_SPRINT' }
  | { type: 'CANCEL_SPRINT' }
  | {
      type: 'START_FOCUS';
      mode: 'oneshot' | 'pomodoro';
      focusMinutes: number;
      breakMinutes: number;
      /** Ignition mode: task + first action this sprint is scoped to */
      taskId?: string;
      intent?: string;
    }
  | { type: 'STOP_FOCUS'; early: boolean }
  | { type: 'ADD_BOOKMARK'; url: string; title: string; groupId: string | null }
  | { type: 'DELETE_BOOKMARK'; id: string }
  | { type: 'MOVE_BOOKMARK'; id: string; groupId: string | null }
  | { type: 'ADD_BOOKMARK_GROUP'; name: string }
  | { type: 'DELETE_BOOKMARK_GROUP'; id: string }
  | { type: 'MEMORY_ADD'; text: string }
  | { type: 'MEMORY_DELETE'; id: string }
  | { type: 'SKILL_ADD'; name: string; keywords: string[]; body: string }
  | {
      type: 'SKILL_UPDATE';
      id: string;
      patch: Partial<Pick<AssistantSkill, 'name' | 'keywords' | 'body' | 'enabled'>>;
    }
  | { type: 'SKILL_DELETE'; id: string }
  | { type: 'GMAIL_CONNECT' }
  | { type: 'GMAIL_DISCONNECT'; accountId: string }
  | { type: 'GMAIL_TRIAGE'; force?: boolean }
  | { type: 'GMAIL_ARCHIVE'; accountId: string; messageId: string }
  | { type: 'GMAIL_LABEL'; accountId: string; messageId: string; labelId: string }
  | { type: 'GMAIL_LIST_LABELS'; accountId: string }
  | { type: 'JOURNAL_APPEND'; kind: JournalEntry['kind']; text: string }
  | { type: 'JOURNAL_SAVE_PLAN'; plan: DayPlan }
  | { type: 'JOURNAL_PATCH_PLAN'; date: string; patch: Partial<DayPlan> }
  | { type: 'AGENT_APPLY_PROPOSALS'; proposals: AgentProposal[] }
  | { type: 'AUTOMATION_ADD'; name: string; prompt: string; schedule: AutomationSchedule }
  | {
      type: 'AUTOMATION_UPDATE';
      id: string;
      patch: Partial<Pick<AssistantAutomation, 'name' | 'prompt' | 'schedule' | 'enabled'>>;
    }
  | { type: 'AUTOMATION_DELETE'; id: string }
  | { type: 'AUTOMATION_RUN_NOW'; id: string }
  | { type: 'SAVE_NOTE'; rawText: string }
  | { type: 'DAILY_GATE_STATUS' }
  | { type: 'STRUCTURE_NOTE_RESULT'; id: string; bullets: string[]; tasks: string[] }
  | { type: 'NOTE_FAILED'; id: string }
  | { type: 'DELETE_NOTE'; id: string }
  /* The worker cannot read an encrypted note's proposed tasks, so the caller —
     which holds the plaintext either way — supplies the text to add. */
  | { type: 'CONFIRM_NOTE_TASKS'; id: string; tasks: { index: number; text: string }[] }
  | { type: 'FLASH_ADD_DECK'; name: string; kind: DeckKind }
  | { type: 'FLASH_RENAME_DECK'; id: string; name: string }
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
  | { type: 'CAL_SIGN_IN' }
  | { type: 'CAL_SIGN_OUT' }
  | { type: 'CAL_REFRESH' }
  | { type: 'CAL_CREATE_EVENT'; title: string; startMs: number; endMs: number }
  | { type: 'CAL_LIST_EVENTS'; startMs: number; endMs: number }
  // Offscreen document ↔ service worker
  | {
      type: 'PROXY_STORAGE';
      area: 'local' | 'session';
      op: 'get' | 'set';
      keys?: string[];
      items?: Record<string, unknown>;
    }
  | { type: 'ASSISTANT_APPEND_TURN'; turn: AssistantTurn }
  | { type: 'ASSISTANT_BEGIN_TURN'; turn: AssistantTurn }
  | { type: 'ASSISTANT_PATCH_TURN'; id: string; patch: Partial<AssistantTurn> }
  // Recording control. Tab and mixed capture must start from the side panel:
  // getMediaStreamId needs the extension to have been invoked on that tab.
  | {
      type: 'REC_START';
      mode: 'mic' | 'tab' | 'mixed';
      /** Required for tab/mixed; the tab whose audio is captured */
      tabId?: number;
      title?: string;
      /** What this recording is for — tailors the summary. 'video' never starts
       *  a capture (YouTube goes through REC_YOUTUBE_IMPORT instead). */
      purpose?: 'meeting' | 'lecture';
    }
  | { type: 'REC_STOP' }
  | { type: 'REC_DELETE'; id: string }
  | { type: 'REC_RENAME'; id: string; title: string }
  | { type: 'REC_YOUTUBE_IMPORT'; url: string }
  // Page → service worker: re-run the summary of a finished transcript
  | { type: 'REC_SUMMARIZE'; id: string }
  // Popup → service worker: capture the current frame of a tab/mixed recording
  | { type: 'REC_CAPTURE_NOW' }
  // Service worker → offscreen doc: begin capture with an acquired stream id
  | {
      type: 'REC_BEGIN';
      id: string;
      mode: 'mic' | 'tab' | 'mixed';
      /** chrome.tabCapture stream id, for tab/mixed */
      streamId?: string;
      /** Sample the tab's video for slide/screen descriptions (tab/mixed only) */
      visualCapture?: boolean;
      /** Vocabulary context for the transcriber — biases technical terms */
      title?: string;
      purpose?: 'meeting' | 'lecture' | 'video';
    }
  // Service worker → offscreen doc: grab a frame right now (router no-ops it)
  | { type: 'REC_GRAB_FRAME' }
  // Offscreen doc → service worker: one segment transcribed, a frame described,
  // or capture ended
  | { type: 'REC_SEGMENT_READY'; id: string; startSec: number; endSec: number; text: string }
  | {
      type: 'REC_VISUAL_READY';
      id: string;
      atSec: number;
      kind: 'auto' | 'manual';
      description: string;
    }
  | { type: 'REC_CAPTURE_ENDED'; id: string; durationSeconds: number; error?: string }
  /* Live mode — suggested answers during a recording. The session itself is read
     straight from chrome.storage.session by the UI; these only mutate it. */
  | { type: 'LIVE_SET_MODE'; mode: LiveMode }
  | { type: 'LIVE_SET_PACE'; pace: LivePace }
  | { type: 'LIVE_PIN_SKILL'; skillId: string }
  /** The Suggest button: answer now, bypassing the pace cooldown */
  | { type: 'LIVE_SUGGEST' }
  /** A follow-up chip, or anything typed at the live panel */
  | { type: 'LIVE_ASK'; question: string }
  /** "What did I miss" — backs the catch_me_up tool */
  | { type: 'LIVE_CATCH_UP'; minutes: number }
  // Content script → service worker
  | { type: 'TRACKER_READY' }
  | { type: 'TIME_PILL_READY'; host: string }
  | { type: 'TIME_PILL_TICK'; host: string; seconds: number }
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
    }
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
    }
  /**
   * Record which works a document cites, so "what links here" can be answered
   * from documents the user has actually opened. Sent once per PDF open, after
   * its bibliography is parsed.
   */
  | { type: 'DOC_CITATIONS_INDEX'; entry: DocCitations }
  /** Fetch what a tracked paper cites and what cites it. User-initiated only. */
  | { type: 'GRAPH_EXPAND_CITATIONS'; paperId: string; force?: boolean }
  /** Promote a borrowed paper from the citation graph into the library. */
  | { type: 'GRAPH_ADD_EXTERNAL'; nodeId: string }
  /**
   * Write subject labels onto cited papers the sources gave none for. Keyed by
   * the source's own id.
   */
  | { type: 'GRAPH_SET_CITED_TAGS'; assignments: { id: string; tags: string[] }[] }
  /**
   * Wrap a title the note already names in `[[…]]`, turning a mention into a
   * link. The caller supplies the text because a sealed note's plaintext exists
   * only in the page that decrypted it — the worker cannot read it.
   */


export interface MessageResponses {
  REFRESH_FEEDS: { ok: boolean; itemCount: number; newCount: number; failedCount: number };
  OPEN_ARTICLE: { ok: boolean };
  ADD_TASK: { ok: boolean; task: Task };
  TOGGLE_TASK: { ok: boolean };
  DELETE_TASK: { ok: boolean };
  EDIT_TASK: { ok: boolean };
  MOVE_TASK: { ok: boolean };
  MARK_ALL_READ: { ok: boolean; count: number };
  VALIDATE_FEED: { ok: boolean; valid: boolean; title: string | null };
  SNOOZE_TASK: { ok: boolean };
  START_SPRINT: { ok: boolean };
  CANCEL_SPRINT: { ok: boolean };
  START_FOCUS: { ok: boolean };
  STOP_FOCUS: { ok: boolean };
  ADD_BOOKMARK: { ok: boolean; bookmark: BookmarkLink };
  DELETE_BOOKMARK: { ok: boolean };
  MOVE_BOOKMARK: { ok: boolean };
  ADD_BOOKMARK_GROUP: { ok: boolean; group: BookmarkGroup };
  DELETE_BOOKMARK_GROUP: { ok: boolean };
  MEMORY_ADD: { ok: boolean; fact?: AssistantFact; error?: string };
  MEMORY_DELETE: { ok: boolean };
  SKILL_ADD: { ok: boolean; skill?: AssistantSkill; error?: string };
  SKILL_UPDATE: { ok: boolean; error?: string };
  SKILL_DELETE: { ok: boolean };
  GMAIL_CONNECT: { ok: boolean; email?: string; error?: string };
  GMAIL_DISCONNECT: { ok: boolean };
  GMAIL_TRIAGE: { ok: boolean; text: string };
  GMAIL_ARCHIVE: { ok: boolean; error?: string };
  GMAIL_LABEL: { ok: boolean; error?: string };
  GMAIL_LIST_LABELS: { ok: boolean; labels: { id: string; name: string }[]; error?: string };
  JOURNAL_APPEND: { ok: boolean };
  JOURNAL_SAVE_PLAN: { ok: boolean };
  JOURNAL_PATCH_PLAN: { ok: boolean };
  AGENT_APPLY_PROPOSALS: {
    ok: boolean;
    outcomes: { status: 'done' | 'failed' | 'skipped'; detail: string }[];
    text: string;
  };
  AUTOMATION_ADD: { ok: boolean; automation?: AssistantAutomation; error?: string };
  AUTOMATION_UPDATE: { ok: boolean; error?: string };
  AUTOMATION_DELETE: { ok: boolean };
  AUTOMATION_RUN_NOW: { ok: boolean; error?: string };
  SAVE_NOTE: { ok: boolean; note: BrainDumpNote; dailyGateCompleted: boolean };
  DAILY_GATE_STATUS: { ok: boolean; complete: boolean };
  STRUCTURE_NOTE_RESULT: { ok: boolean };
  NOTE_FAILED: { ok: boolean };
  DELETE_NOTE: { ok: boolean };
  CONFIRM_NOTE_TASKS: { ok: boolean; addedCount: number };
  FLASH_ADD_DECK: { ok: boolean; deck?: Deck; error?: string };
  FLASH_RENAME_DECK: { ok: boolean; error?: string };
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
  CAL_SIGN_IN: { ok: boolean; email?: string; error?: string };
  CAL_SIGN_OUT: { ok: boolean };
  CAL_REFRESH: { ok: boolean; error?: string };
  CAL_CREATE_EVENT: { ok: boolean; event?: CalendarEvent; error?: string };
  CAL_LIST_EVENTS: { ok: boolean; events?: CalendarEvent[]; error?: string };
  PROXY_STORAGE: Record<string, unknown>;
  ASSISTANT_APPEND_TURN: { ok: boolean };
ASSISTANT_BEGIN_TURN: { thread: AssistantTurn[] };
  ASSISTANT_PATCH_TURN: { ok: boolean };
  REC_START: { ok: boolean; id?: string; error?: string };
  REC_STOP: { ok: boolean };
  REC_DELETE: { ok: boolean };
  REC_RENAME: { ok: boolean };
  REC_YOUTUBE_IMPORT: { ok: boolean; id?: string; error?: string };
  REC_SUMMARIZE: { ok: boolean; error?: string };
  REC_CAPTURE_NOW: { ok: boolean; error?: string };
  REC_BEGIN: { ok: boolean };
  REC_GRAB_FRAME: { ok: boolean };
  REC_SEGMENT_READY: { ok: boolean };
  REC_VISUAL_READY: { ok: boolean };
  REC_CAPTURE_ENDED: { ok: boolean };
  LIVE_SET_MODE: { ok: boolean };
  LIVE_SET_PACE: { ok: boolean };
  LIVE_PIN_SKILL: { ok: boolean };
  LIVE_SUGGEST: { ok: boolean };
  LIVE_ASK: { ok: boolean };
  LIVE_CATCH_UP: { text: string };
  TRACKER_READY: { ok: boolean; resume: ResumeTarget | null };
  TIME_PILL_READY: { ok: boolean; todaySeconds: number };
  TIME_PILL_TICK: { ok: boolean };
  PROGRESS_UPDATE: { ok: boolean };
  VIDEO_TRACKER_READY: {
    ok: boolean;
    track: boolean;
    resume: { positionSeconds: number } | null;
  };
  VIDEO_PROGRESS: { ok: boolean };
  DOC_CITATIONS_INDEX: { ok: boolean };
  GRAPH_EXPAND_CITATIONS: { ok: boolean; added?: number; note?: string; error?: string };
  GRAPH_ADD_EXTERNAL: { ok: boolean; paperId?: string; error?: string };
  GRAPH_SET_CITED_TAGS: { ok: boolean; updated: number };
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

/**
 * Send to OTHER contexts, bypassing the in-process dispatcher above.
 *
 * The service worker must use this for anything addressed to the offscreen
 * document. Plain sendMessage would resolve against the router instead, which
 * answers with the no-op case that exists for page broadcasts — so the call
 * looks like it succeeded while the document never heard a thing.
 *
 * Nothing replies to these (the offscreen listener deliberately never calls
 * sendResponse), so Chrome closes the port and rejects; that rejection is the
 * expected outcome, not a failure.
 */
export function broadcastMessage(msg: Message): Promise<void> {
  return chrome.runtime.sendMessage(msg).then(
    () => undefined,
    () => undefined,
  );
}
