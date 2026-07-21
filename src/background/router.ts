import type { Message } from '../shared/messages';
import { appendTurn } from '../shared/ai/assistantTypes';
import { getActivePageContent } from '../shared/ai/pageContent';
import { getSession, setSession } from '../shared/storage';
import { handleWakeEvent } from './offscreen';
import { calSignIn, calSignOut, createCalendarEvent, listEvents, refreshCalendar } from './calendar';
import { refreshMeetingNotes } from './meetingNotes';
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
import { addAnnotation, deleteAnnotation, updateAnnotation } from './annotations';
import { addPaper, deletePaper, handleReaderProgress, updatePaper } from './papers';
import { openNativePdf } from './pdfIntercept';
import { getSyncStatus } from './sync';
import { signIn, signOutSync, signUp } from './firestoreBackend';
import { startFocus, stopFocus } from './focus';
import { addFact, deleteFact } from './memory';
import { addSkill, deleteSkill, updateSkill } from './skills';
import { applyProposals } from './agentRuns';
import { addAutomation, deleteAutomation, runAutomation, updateAutomation } from './automations';
import { flushQueue, listDatabases, testConnection } from './notion';
import { gymCheckin, gymUndo } from './gym';
import { completeWarmup } from './warmup';
import { cancelSprint, startSprint } from './streaks';
import { addTask, deleteTask, editTask, moveTask, snoozeTask, toggleTask } from './tasks';
import { handleTimePillReady, handleTimePillTick } from './timePill';
import { getResumeTarget, handleProgressUpdate } from './tracking';
import { handleVideoProgress, handleVideoReady } from './videoTracking';

/** Run an auth action and normalize Firebase errors into a UI-friendly result. */
async function authResult(action: () => Promise<void>): Promise<{ ok: boolean; error?: string }> {
  try {
    await action();
    return { ok: true };
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    const messages: Record<string, string> = {
      'auth/invalid-email': 'That email address looks invalid.',
      'auth/invalid-credential': 'Incorrect email or password.',
      'auth/wrong-password': 'Incorrect email or password.',
      'auth/user-not-found': 'No account with that email — create one first.',
      'auth/email-already-in-use': 'An account with that email already exists — sign in instead.',
      'auth/weak-password': 'Password must be at least 6 characters.',
      'auth/network-request-failed': 'Network error — check your connection.',
      'auth/operation-not-allowed':
        'Email/Password sign-in is not enabled — turn it on in Firebase console → Authentication → Sign-in method.',
      'auth/configuration-not-found':
        'Firebase Authentication isn’t set up — open Authentication in the console and enable Email/Password.',
    };
    return { ok: false, error: messages[code] ?? (error as Error).message ?? 'Something went wrong.' };
  }
}

/** Exported so the SW can register itself as the in-process message dispatcher */
export async function dispatch(msg: Message, sender: chrome.runtime.MessageSender): Promise<unknown> {
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
    case 'EDIT_TASK':
      await editTask(msg.id, msg.text);
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
    case 'WARMUP_COMPLETE':
      return completeWarmup(msg.score, msg.total);
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
    case 'MEMORY_ADD':
      return addFact(msg.text);
    case 'MEMORY_DELETE':
      await deleteFact(msg.id);
      return { ok: true };
    case 'SKILL_ADD':
      return addSkill({ name: msg.name, keywords: msg.keywords, body: msg.body });
    case 'SKILL_UPDATE':
      return updateSkill(msg.id, msg.patch);
    case 'SKILL_DELETE':
      await deleteSkill(msg.id);
      return { ok: true };
    case 'AGENT_APPLY_PROPOSALS':
      return applyProposals(msg.proposals);
    case 'AUTOMATION_ADD':
      return addAutomation({ name: msg.name, prompt: msg.prompt, schedule: msg.schedule });
    case 'AUTOMATION_UPDATE':
      return updateAutomation(msg.id, msg.patch);
    case 'AUTOMATION_DELETE':
      await deleteAutomation(msg.id);
      return { ok: true };
    case 'AUTOMATION_RUN_NOW':
      return runAutomation(msg.id, { force: true });
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
    case 'PAPER_READER_PROGRESS':
      return handleReaderProgress(msg.paperId, {
        pdfUrl: msg.pdfUrl,
        page: msg.page,
        pageCount: msg.pageCount,
        offset: msg.offset,
        leftOff: msg.leftOff,
      });
    case 'ANNOT_ADD':
      return addAnnotation(msg.draft);
    case 'ANNOT_UPDATE':
      return updateAnnotation(msg.id, msg.patch);
    case 'ANNOT_DELETE':
      return deleteAnnotation(msg.id);
    case 'READER_OPEN_NATIVE': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return { ok: false };
      return openNativePdf(tabId, msg.url);
    }
    case 'CAL_SIGN_IN':
      return calSignIn();
    case 'CAL_SIGN_OUT':
      return calSignOut();
    case 'CAL_REFRESH':
      return refreshCalendar();
    case 'CAL_CREATE_EVENT':
      return createCalendarEvent(msg.title, msg.startMs, msg.endMs);
    case 'CAL_LIST_EVENTS':
      return listEvents(msg.startMs, msg.endMs);
    case 'MEETING_NOTES_REFRESH':
      return refreshMeetingNotes();
    case 'SYNC_STATUS':
      return getSyncStatus();
    case 'SYNC_SIGN_IN':
      return authResult(() => signIn(msg.email, msg.password));
    case 'SYNC_SIGN_UP':
      return authResult(() => signUp(msg.email, msg.password));
    case 'SYNC_SIGN_OUT':
      return authResult(() => signOutSync());
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
    // Offscreen wake-word listener (no chrome.storage/tabs there — SW does it)
    case 'PROXY_STORAGE': {
      if (msg.op === 'get') return chrome.storage[msg.area].get(msg.keys ?? []);
      await chrome.storage[msg.area].set(msg.items ?? {});
      return {};
    }
    case 'ASSISTANT_APPEND_TURN': {
      // Read-modify-write is safe here: the single SW context serializes it
      const { assistantThread } = await getSession('assistantThread');
      await setSession({ assistantThread: appendTurn(assistantThread, msg.turn) });
      return { ok: true };
    }
    case 'ASSISTANT_BEGIN_TURN': {
      // Append the user turn and hand back the PRIOR thread in one round
      // trip — saves the offscreen doc a getSession hop per wake turn
      const { assistantThread } = await getSession('assistantThread');
      await setSession({ assistantThread: appendTurn(assistantThread, msg.turn) });
      return { thread: assistantThread };
    }
    case 'ASSISTANT_PATCH_TURN': {
      const { assistantThread } = await getSession('assistantThread');
      await setSession({
        assistantThread: assistantThread.map((t) => (t.id === msg.id ? { ...t, ...msg.patch } : t)),
      });
      return { ok: true };
    }
    case 'WAKE_GET_PAGE':
      return { page: await getActivePageContent() };
    case 'WAKE_EVENT':
      await handleWakeEvent(msg.event, msg.text);
      return { ok: true };
    case 'WAKE_MIC_BUSY':
      // Addressed to the offscreen doc, which listens on the same broadcast
      return { ok: true };
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
