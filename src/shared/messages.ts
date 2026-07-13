import type { CalendarEvent } from './calendar';
import type { NotionDbSummary } from './notion';
import type { SyncLocalState } from './storage';
import type {
  AssistantFact,
  BookmarkGroup,
  BookmarkLink,
  BrainDumpNote,
  Deck,
  DeckKind,
  FlashNote,
  FlashNoteType,
  Paper,
  PaperDraft,
  Rating,
  Task,
} from './types';

export interface ResumeTarget {
  scrollY: number;
  pageHeight: number;
}

export type Message =
  | { type: 'REFRESH_FEEDS' }
  | { type: 'OPEN_ARTICLE'; url: string; feedItemId: string | null; resume?: boolean }
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
  | { type: 'GYM_CHECKIN' }
  | { type: 'GYM_UNDO' }
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
  | { type: 'SAVE_NOTE'; rawText: string; willStructure: boolean }
  | { type: 'STRUCTURE_NOTE_RESULT'; id: string; bullets: string[]; tasks: string[] }
  | { type: 'NOTE_FAILED'; id: string }
  | { type: 'DELETE_NOTE'; id: string }
  | { type: 'CONFIRM_NOTE_TASKS'; id: string; taskIndexes: number[] }
  | { type: 'NOTION_LIST_DBS' }
  | { type: 'NOTION_TEST' }
  | { type: 'NOTION_FLUSH_NOW' }
  | { type: 'FLASH_ADD_DECK'; name: string; kind: DeckKind }
  | { type: 'FLASH_RENAME_DECK'; id: string; name: string }
  | { type: 'FLASH_DELETE_DECK'; id: string }
  | {
      type: 'FLASH_ADD_NOTE';
      deckId: string;
      noteType: FlashNoteType;
      front: string;
      back: string;
      reversed: boolean;
    }
  | { type: 'FLASH_UPDATE_NOTE'; id: string; front: string; back: string; reversed: boolean }
  | { type: 'FLASH_DELETE_NOTE'; id: string }
  | { type: 'FLASH_ANSWER_CARD'; cardId: string; rating: Rating }
  | { type: 'FLASH_RESET_CARD'; cardId: string }
  | { type: 'PAPER_ADD'; draft: PaperDraft }
  | { type: 'PAPER_UPDATE'; id: string; patch: Partial<PaperDraft> }
  | { type: 'PAPER_DELETE'; id: string }
  | { type: 'CAL_SIGN_IN' }
  | { type: 'CAL_SIGN_OUT' }
  | { type: 'CAL_REFRESH' }
  | { type: 'CAL_CREATE_EVENT'; title: string; startMs: number; endMs: number }
  | { type: 'CAL_LIST_EVENTS'; startMs: number; endMs: number }
  | { type: 'SYNC_STATUS' }
  | { type: 'SYNC_SIGN_IN'; email: string; password: string }
  | { type: 'SYNC_SIGN_UP'; email: string; password: string }
  | { type: 'SYNC_SIGN_OUT' }
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
    };

export interface MessageResponses {
  REFRESH_FEEDS: { ok: boolean; itemCount: number };
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
  GYM_CHECKIN: { ok: boolean };
  GYM_UNDO: { ok: boolean };
  START_FOCUS: { ok: boolean };
  STOP_FOCUS: { ok: boolean };
  ADD_BOOKMARK: { ok: boolean; bookmark: BookmarkLink };
  DELETE_BOOKMARK: { ok: boolean };
  MOVE_BOOKMARK: { ok: boolean };
  ADD_BOOKMARK_GROUP: { ok: boolean; group: BookmarkGroup };
  DELETE_BOOKMARK_GROUP: { ok: boolean };
  MEMORY_ADD: { ok: boolean; fact?: AssistantFact; error?: string };
  MEMORY_DELETE: { ok: boolean };
  SAVE_NOTE: { ok: boolean; note: BrainDumpNote };
  STRUCTURE_NOTE_RESULT: { ok: boolean };
  NOTE_FAILED: { ok: boolean };
  DELETE_NOTE: { ok: boolean };
  CONFIRM_NOTE_TASKS: { ok: boolean; addedCount: number };
  NOTION_LIST_DBS: { ok: boolean; databases: NotionDbSummary[]; error: string | null };
  NOTION_TEST: { ok: boolean; name: string | null; error: string | null };
  NOTION_FLUSH_NOW: { ok: boolean };
  FLASH_ADD_DECK: { ok: boolean; deck?: Deck; error?: string };
  FLASH_RENAME_DECK: { ok: boolean; error?: string };
  FLASH_DELETE_DECK: { ok: boolean; error?: string };
  FLASH_ADD_NOTE: { ok: boolean; note?: FlashNote; error?: string };
  FLASH_UPDATE_NOTE: { ok: boolean; error?: string };
  FLASH_DELETE_NOTE: { ok: boolean; error?: string };
  FLASH_ANSWER_CARD: { ok: boolean; error?: string };
  FLASH_RESET_CARD: { ok: boolean; error?: string };
  PAPER_ADD: { ok: boolean; paper?: Paper; error?: string };
  PAPER_UPDATE: { ok: boolean; error?: string };
  PAPER_DELETE: { ok: boolean; error?: string };
  CAL_SIGN_IN: { ok: boolean; email?: string; error?: string };
  CAL_SIGN_OUT: { ok: boolean };
  CAL_REFRESH: { ok: boolean; error?: string };
  CAL_CREATE_EVENT: { ok: boolean; event?: CalendarEvent; error?: string };
  CAL_LIST_EVENTS: { ok: boolean; events?: CalendarEvent[]; error?: string };
  SYNC_STATUS: SyncLocalState;
  SYNC_SIGN_IN: { ok: boolean; error?: string };
  SYNC_SIGN_UP: { ok: boolean; error?: string };
  SYNC_SIGN_OUT: { ok: boolean; error?: string };
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
}

export function sendMessage<T extends Message['type']>(
  msg: Extract<Message, { type: T }>,
): Promise<MessageResponses[T]> {
  return chrome.runtime.sendMessage(msg);
}
