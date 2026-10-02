import type { Message } from '../shared/messages';
import { markAllRead, openArticle, refreshFeeds } from './feeds';
import { validateFeed } from './rssParser';
import {
  addBookmark,
  addBookmarkGroup,
  deleteBookmark,
  deleteBookmarkGroup,
  moveBookmark,
} from './bookmarks';
import { addDeck, deleteDeck } from './flashcards';
import { addAnnotation, deleteAnnotation, moveAnnotation, updateAnnotation } from './annotations';
import { addPaper, deletePaper, handleReaderProgress, updatePaper } from './papers';
import { openNativePdf } from './pdfIntercept';
import { startFocus, stopFocus } from './focus';
import { getResumeTarget, handleProgressUpdate } from './tracking';
import { transcriptFor } from './videoContext';
import { focusExistingVideoTab, handleVideoProgress, handleVideoReady } from './videoTracking';

/** Exported so the SW can register itself as the in-process message dispatcher */
export async function dispatch(
  msg: Message,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (msg.type) {
    case 'REFRESH_FEEDS':
      return refreshFeeds();
    case 'OPEN_ARTICLE':
      return openArticle(msg.url, msg.feedItemId, msg.resume ?? false, msg.readerView ?? true, msg.original ?? false);
    case 'MARK_ALL_READ':
      return markAllRead();
    case 'VALIDATE_FEED':
      return { ok: true, ...(await validateFeed(msg.url)) };
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
    case 'FLASH_ADD_DECK':
      return addDeck(msg.name, msg.kind);
    case 'FLASH_DELETE_DECK':
      return deleteDeck(msg.id);
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
    case 'FOCUS_VIDEO_TAB':
      return { ok: await focusExistingVideoTab(msg.videoId) };
    case 'VIDEO_TRANSCRIPT': {
      const res = await transcriptFor(msg.videoId);
      return 'error' in res ? { ok: false, error: res.error } : { ok: true, segments: res.segments };
    }
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
