import type { Message } from '../shared/messages';
import { signIn, signOut, syncLibrary } from './alphaxiv';
import { addAnnotation, deleteAnnotation, moveAnnotation, updateAnnotation } from './annotations';
import { focusReader, readerOpened } from './focus';
import { handleReaderProgress } from './papers';
import { openNativePdf } from './pdfIntercept';

/** Exported so the SW can register itself as the in-process message dispatcher */
export async function dispatch(
  msg: Message,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (msg.type) {
    case 'READER_OPENED': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return { ok: false };
      return readerOpened(tabId, msg.title);
    }
    case 'FOCUS_READER':
      return focusReader();
    case 'ALPHAXIV_SIGN_IN':
      return signIn();
    case 'ALPHAXIV_SIGN_OUT':
      return signOut();
    case 'ALPHAXIV_SYNC':
      return syncLibrary(msg.force ?? false);
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
