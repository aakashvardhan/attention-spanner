import type { Message } from '../shared/messages';
import { calSignIn, calSignOut, createCalendarEvent, refreshCalendar } from './calendar';
import { markAllRead, openArticle, refreshFeeds } from './feeds';
import { validateFeed } from './rssParser';
import {
  applyStructureResult,
  confirmNoteTasks,
  deleteNote,
  markNoteFailed,
  saveNote,
} from './notes';
import {
  addBookmark,
  addBookmarkGroup,
  deleteBookmark,
  deleteBookmarkGroup,
  moveBookmark,
} from './bookmarks';
import {
  addDeck,
  addNote,
  answerCard,
  deleteDeck,
  deleteNote as deleteFlashNote,
  renameDeck,
  resetCard,
  updateNote,
} from './flashcards';
import { addPaper, deletePaper, updatePaper } from './papers';
import { startFocus, stopFocus } from './focus';
import { flushQueue, listDatabases, testConnection } from './notion';
import { gymCheckin, gymUndo } from './gym';
import { cancelSprint, startSprint } from './streaks';
import { addTask, deleteTask, moveTask, snoozeTask, toggleTask } from './tasks';
import { handleTimePillReady, handleTimePillTick } from './timePill';
import { getResumeTarget, handleProgressUpdate } from './tracking';
import { handleVideoProgress, handleVideoReady } from './videoTracking';

async function dispatch(msg: Message, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'REFRESH_FEEDS':
      return refreshFeeds();
    case 'OPEN_ARTICLE':
      return openArticle(msg.url, msg.feedItemId, msg.resume ?? false);
    case 'ADD_TASK':
      return { ok: true, task: await addTask(msg.text, msg.source) };
    case 'TOGGLE_TASK':
      await toggleTask(msg.id);
      return { ok: true };
    case 'DELETE_TASK':
      await deleteTask(msg.id);
      return { ok: true };
    case 'MOVE_TASK':
      await moveTask(msg.id, msg.toIndex);
      return { ok: true };
    case 'MARK_ALL_READ':
      return markAllRead();
    case 'VALIDATE_FEED':
      return { ok: true, ...(await validateFeed(msg.url)) };
    case 'SNOOZE_TASK':
      await snoozeTask(msg.id, msg.minutes);
      return { ok: true };
    case 'START_SPRINT':
      return startSprint();
    case 'CANCEL_SPRINT':
      return cancelSprint();
    case 'GYM_CHECKIN':
      return gymCheckin();
    case 'GYM_UNDO':
      return gymUndo();
    case 'START_FOCUS':
      return startFocus(msg);
    case 'STOP_FOCUS':
      return stopFocus(msg.early);
    case 'ADD_BOOKMARK':
      return { ok: true, bookmark: await addBookmark(msg.url, msg.title, msg.groupId) };
    case 'DELETE_BOOKMARK':
      await deleteBookmark(msg.id);
      return { ok: true };
    case 'MOVE_BOOKMARK':
      await moveBookmark(msg.id, msg.groupId);
      return { ok: true };
    case 'ADD_BOOKMARK_GROUP':
      return { ok: true, group: await addBookmarkGroup(msg.name) };
    case 'DELETE_BOOKMARK_GROUP':
      await deleteBookmarkGroup(msg.id);
      return { ok: true };
    case 'SAVE_NOTE':
      return { ok: true, note: await saveNote(msg.rawText, msg.willStructure) };
    case 'NOTION_LIST_DBS':
      return listDatabases();
    case 'NOTION_TEST':
      return testConnection();
    case 'NOTION_FLUSH_NOW':
      void flushQueue();
      return { ok: true };
    case 'FLASH_ADD_DECK':
      return addDeck(msg.name, msg.kind);
    case 'FLASH_RENAME_DECK':
      return renameDeck(msg.id, msg.name);
    case 'FLASH_DELETE_DECK':
      return deleteDeck(msg.id);
    case 'FLASH_ADD_NOTE':
      return addNote(msg.deckId, msg.noteType, msg.front, msg.back, msg.reversed);
    case 'FLASH_UPDATE_NOTE':
      return updateNote(msg.id, { front: msg.front, back: msg.back, reversed: msg.reversed });
    case 'FLASH_DELETE_NOTE':
      return deleteFlashNote(msg.id);
    case 'FLASH_ANSWER_CARD':
      return answerCard(msg.cardId, msg.rating);
    case 'FLASH_RESET_CARD':
      return resetCard(msg.cardId);
    case 'PAPER_ADD':
      return addPaper(msg.draft);
    case 'PAPER_UPDATE':
      return updatePaper(msg.id, msg.patch);
    case 'PAPER_DELETE':
      return deletePaper(msg.id);
    case 'CAL_SIGN_IN':
      return calSignIn();
    case 'CAL_SIGN_OUT':
      return calSignOut();
    case 'CAL_REFRESH':
      return refreshCalendar();
    case 'CAL_CREATE_EVENT':
      return createCalendarEvent(msg.title, msg.startMs, msg.endMs);
    case 'STRUCTURE_NOTE_RESULT':
      await applyStructureResult(msg.id, msg.bullets, msg.tasks);
      return { ok: true };
    case 'NOTE_FAILED':
      await markNoteFailed(msg.id);
      return { ok: true };
    case 'DELETE_NOTE':
      await deleteNote(msg.id);
      return { ok: true };
    case 'CONFIRM_NOTE_TASKS':
      return { ok: true, ...(await confirmNoteTasks(msg.id, msg.taskIndexes)) };
    case 'TRACKER_READY':
      return {
        ok: true,
        resume: sender.tab?.id !== undefined ? await getResumeTarget(sender.tab.id) : null,
      };
    case 'PROGRESS_UPDATE':
      await handleProgressUpdate(sender, msg);
      return { ok: true };
    case 'VIDEO_TRACKER_READY':
      return handleVideoReady(sender, msg);
    case 'VIDEO_PROGRESS':
      await handleVideoProgress(sender, msg);
      return { ok: true };
    case 'TIME_PILL_READY':
      return handleTimePillReady(msg.host);
    case 'TIME_PILL_TICK':
      return handleTimePillTick(msg.host, msg.seconds);
  }
}

export function handleMessage(
  msg: Message,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): boolean {
  dispatch(msg, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error('[router] message failed:', msg.type, error);
      sendResponse({ ok: false });
    });
  return true; // keep the channel open for the async response
}
