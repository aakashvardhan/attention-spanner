import type { Message } from '../shared/messages';
import { OFFSCREEN_PAGE_PATH } from '../shared/constants';
import { appendTurn } from '../shared/ai/assistantTypes';
import { getSession, setSession } from '../shared/storage';
import {
  axAskPdf,
  axConnect,
  axDisconnect,
  axDiscover,
  axLibrary,
  axPaperContent,
  axSavePaper,
} from './alphaxiv';
import { calSignIn, calSignOut, createCalendarEvent, listEvents, refreshCalendar } from './calendar';
import { markAllRead, openArticle, refreshFeeds } from './feeds';
import { validateFeed } from './rssParser';
import {
  addNoteLink,
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
import {
  addAnnotation,
  deleteAnnotation,
  moveAnnotation,
  updateAnnotation,
} from './annotations';
import { reconcileDailyBrainDump } from './dailyBrainDump';
import { addPaper, deletePaper, handleReaderProgress, updatePaper } from './papers';
import {
  captureNow,
  deleteRecording,
  handleCaptureEnded,
  handleSegmentReady,
  handleVisualReady,
  importYouTubeCaptions,
  renameRecording,
  startRecording,
  stopRecording,
  summarizeRecording,
} from './recordings';
import { askLive, catchMeUp, pinSkill, setMode, setPace, suggestNow } from './live';
import { openNativePdf } from './pdfIntercept';
import { getSyncStatus } from './sync';
import { signIn, signOutSync, signUp } from './firestoreBackend';
import { startFocus, stopFocus } from './focus';
import { archiveMessage, labelMessage, listLabels } from './gmail';
import { connect as gmailConnect, disconnect as gmailDisconnect } from './gmailAuth';
import { dropFromTriage, runTriage } from './gmailTriage';
import { patchDayPlan, recordEntry, savePlan } from './journal';
import { addFact, deleteFact } from './memory';
import { addSkill, deleteSkill, updateSkill } from './skills';
import { applyProposals } from './agentRuns';
import { addAutomation, deleteAutomation, runAutomation, updateAutomation } from './automations';
import { addExternalPaper, applyCitedTags, expandCitations } from './citations';
import { indexDocCitations } from './docCitations';
import { applyTags, reconcileGraphNodes, setManualTags } from './graphNodes';
import { cancelSprint, startSprint } from './streaks';
import { addTask, deleteTask, editTask, moveTask, snoozeTask, toggleTask } from './tasks';
import { handleTimePillReady, handleTimePillTick } from './timePill';
import { getResumeTarget, handleProgressUpdate } from './tracking';
import { handleVideoProgress, handleVideoReady } from './videoTracking';
import { isXBookmarksUrl, openXBookmarks, saveVisibleXBookmarks } from './xBookmarks';

/**
 * Is this message from our own offscreen document? Its sender.url is the
 * extension-origin offscreen page; content scripts report the page's URL and
 * other extension surfaces report their own page, so neither can pass. The
 * in-process dispatcher passes an empty sender ({} — see setLocalDispatcher),
 * which also fails, and correctly: the worker has chrome.storage itself and
 * never proxies.
 */
function isOffscreenSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.url === chrome.runtime.getURL(OFFSCREEN_PAGE_PATH);
}

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
      return openArticle(msg.url, msg.feedItemId, msg.resume ?? false, msg.readerView ?? true);
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
    case 'X_BOOKMARKS_OPEN':
      await openXBookmarks();
      return { ok: true };
    case 'X_BOOKMARKS_SYNC':
      // Content-script messages share the extension channel with every page,
      // so only accept personal bookmark data from X's bookmarks route.
      if (!isXBookmarksUrl(sender.url)) return { ok: false, count: 0 };
      return { ok: true, count: await saveVisibleXBookmarks(msg.items) };
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
    case 'GMAIL_CONNECT':
      return gmailConnect();
    case 'GMAIL_DISCONNECT':
      return gmailDisconnect(msg.accountId);
    case 'GMAIL_TRIAGE':
      return runTriage({ force: msg.force });
    case 'GMAIL_ARCHIVE':
      try {
        await archiveMessage(msg.accountId, msg.messageId);
        await dropFromTriage(msg.messageId);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    case 'GMAIL_LABEL':
      try {
        await labelMessage(msg.accountId, msg.messageId, msg.labelId);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    case 'GMAIL_LIST_LABELS':
      try {
        return { ok: true, labels: await listLabels(msg.accountId) };
      } catch (err) {
        return { ok: false, labels: [], error: (err as Error).message };
      }
    case 'JOURNAL_APPEND':
      await recordEntry(msg.kind, msg.text);
      return { ok: true };
    case 'JOURNAL_SAVE_PLAN':
      await savePlan(msg.plan);
      return { ok: true };
    case 'JOURNAL_PATCH_PLAN':
      await patchDayPlan(msg.date, msg.patch);
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
      return { ok: true, ...(await saveNote(msg.rawText)) };
    case 'DAILY_GATE_STATUS':
      return { ok: true, ...(await reconcileDailyBrainDump()) };
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
    case 'ANNOT_MOVE':
      return moveAnnotation(msg.id, msg.x, msg.y);
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
    case 'AX_CONNECT':
      return axConnect();
    case 'AX_DISCONNECT':
      return axDisconnect();
    case 'AX_LIBRARY':
      return axLibrary();
    case 'AX_DISCOVER':
      return axDiscover(msg.topic, msg.recent);
    case 'AX_PAPER_CONTENT':
      return axPaperContent(msg.paper, msg.fullText);
    case 'AX_ASK_PDF':
      return axAskPdf(msg.paper, msg.queries);
    case 'AX_SAVE_PAPER':
      return axSavePaper(msg.paper);
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
      return { ok: true, ...(await confirmNoteTasks(msg.id, msg.tasks)) };
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
    case 'GRAPH_SYNC':
      await reconcileGraphNodes();
      return { ok: true };
    case 'GRAPH_SET_TAGS':
      return applyTags(msg.assignments);
    case 'GRAPH_SET_MANUAL_TAGS':
      return setManualTags(msg.id, msg.tags);
    case 'DOC_CITATIONS_INDEX':
      return indexDocCitations(msg.entry);
    case 'GRAPH_EXPAND_CITATIONS':
      return expandCitations(msg.paperId, msg.force ?? false);
    case 'GRAPH_ADD_EXTERNAL':
      return addExternalPaper(msg.nodeId);
    case 'GRAPH_SET_CITED_TAGS':
      return applyCitedTags(msg.assignments);
    case 'NOTE_ADD_LINK':
      return addNoteLink(msg.id, msg.rawText);
    case 'TIME_PILL_READY':
      return handleTimePillReady(msg.host);
    case 'TIME_PILL_TICK':
      return handleTimePillTick(msg.host, msg.seconds);
    // Offscreen wake-word listener (no chrome.storage/tabs there — SW does it).
    // This is an unrestricted read/write of everything in storage: `get([])`
    // hands back the API keys, the Google client secret and the refresh
    // tokens. The offscreen document is the only context that needs it (every
    // other one has chrome.storage directly), so nothing else may ask — a
    // content script on a hostile page shares this same message channel.
    case 'PROXY_STORAGE': {
      if (!isOffscreenSender(sender)) {
        console.warn('[router] PROXY_STORAGE from an unexpected sender:', sender.url);
        return { ok: false };
      }
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
    case 'REC_BEGIN':
    case 'REC_GRAB_FRAME':
      // Addressed to the offscreen doc, which listens on the same broadcast
      return { ok: true };
    case 'REC_START':
      return startRecording(msg.mode, msg.tabId, msg.title, msg.purpose);
    case 'REC_STOP':
      // The offscreen recorder stops itself off the same broadcast
      return stopRecording();
    case 'REC_SEGMENT_READY':
      await handleSegmentReady(msg);
      return { ok: true };
    case 'REC_VISUAL_READY':
      await handleVisualReady(msg);
      return { ok: true };
    case 'REC_CAPTURE_ENDED':
      await handleCaptureEnded(msg);
      return { ok: true };
    case 'LIVE_SET_MODE':
      await setMode(msg.mode);
      return { ok: true };
    case 'LIVE_SET_PACE':
      await setPace(msg.pace);
      return { ok: true };
    case 'LIVE_PIN_SKILL':
      await pinSkill(msg.skillId);
      return { ok: true };
    case 'LIVE_SUGGEST':
      await suggestNow();
      return { ok: true };
    case 'LIVE_ASK':
      await askLive(msg.question);
      return { ok: true };
    case 'LIVE_CATCH_UP':
      return { text: await catchMeUp(msg.minutes) };
    case 'REC_DELETE':
      return deleteRecording(msg.id);
    case 'REC_RENAME':
      return renameRecording(msg.id, msg.title);
    case 'REC_SUMMARIZE':
      return summarizeRecording(msg.id);
    case 'REC_CAPTURE_NOW':
      return captureNow();
    case 'REC_YOUTUBE_IMPORT':
      return importYouTubeCaptions(msg.url);
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
