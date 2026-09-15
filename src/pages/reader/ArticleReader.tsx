import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { annotationDocKey, sortAnnotations } from '../../shared/annotations';
import { DEFAULT_ANNOTATION_COLOR } from '../../shared/annotations';
import { sendMessage } from '../../shared/messages';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import type { TextAnchor } from '../../shared/textAnchor';
import type { AnnotationColor } from '../../shared/types';
import { AnnotationsSidebar } from './components/AnnotationsSidebar';
import { ArticleViewport, type ArticleViewportHandle } from './components/ArticleViewport';
import { OutlineSidebar } from './components/OutlineSidebar';
import { ReaderToolbar } from './components/ReaderToolbar';
import { useArticleDocument } from './useArticleDocument';

/** One progress write at most every 5s, matching the PDF reader. */
const PROGRESS_THROTTLE_MS = 5_000;

/**
 * Articles in the same shell as PDFs: highlights, sticky notes, outline, Ask,
 * and resume. Progress is reported through the same PROGRESS_UPDATE message
 * the reading-tracker content script sends, so streaks, nudges and the
 * Continue card need no special case for reader-opened articles.
 */
export function ArticleReader({ url }: { url: string }) {
  const state = useArticleDocument(url);
  const docKey = useMemo(() => annotationDocKey(url), [url]);

  const [allAnnotations] = useStorageValue('annotations');
  const docAnnotations = useMemo(
    () => sortAnnotations(allAnnotations.filter((a) => a.docKey === docKey)),
    [allAnnotations, docKey],
  );

  const [activeId, setActiveId] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [panel, setPanel] = useState<'none' | 'notes' | 'ask'>('none');
  const notesOpen = panel === 'notes';
  const [blockIndex, setBlockIndex] = useState(0);
  const viewportRef = useRef<ArticleViewportHandle>(null);

  const ready = state.status === 'ready';
  const blocks = ready ? state.blocks : [];
  const title = ready ? state.title : url;

  const progress = useRef({ lastSentAt: 0, percent: 0, title: '' });
  // While loading, `title` is the URL — a fine placeholder on screen, but stored
  // it would stick as the article's name in the Continue list. Report nothing
  // until the document is parsed and the tracker keeps the name it already has.
  progress.current.title = ready ? state.title : '';

  const send = useCallback(
    (percent: number, hidden: boolean) => {
      const now = Date.now();
      const since = progress.current.lastSentAt;
      progress.current.lastSentAt = now;
      void sendMessage({
        type: 'PROGRESS_UPDATE',
        percent,
        scrollY: 0,
        pageHeight: 0,
        // Credit at most one throttle window, so a tab left open in the
        // background can't bank hours of "reading"
        activeSecondsDelta: since === 0 ? 0 : Math.min((now - since) / 1000, PROGRESS_THROTTLE_MS / 1000),
        hidden,
        doc: { url, title: progress.current.title },
      });
    },
    [url],
  );

  const onProgress = useCallback(
    (percent: number, currentBlock: number) => {
      setBlockIndex(currentBlock);
      progress.current.percent = percent;
      if (Date.now() - progress.current.lastSentAt < PROGRESS_THROTTLE_MS) return;
      send(percent, false);
    },
    [send],
  );

  // Leaving the tab flushes the latest position, mirroring the PDF reader
  useEffect(() => {
    const flush = () => send(progress.current.percent, true);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, [send]);

  const createHighlight = useCallback(
    (anchor: TextAnchor, text: string, color: AnnotationColor) => {
      void sendMessage({
        type: 'ANNOT_ADD',
        draft: {
          docKey,
          docUrl: url,
          paperId: null,
          kind: 'highlight',
          anchor: { kind: 'text', ...anchor },
          text,
          color,
          note: '',
        },
      });
    },
    [docKey, url],
  );

  const addSticky = useCallback(async () => {
    const res = await sendMessage({
      type: 'ANNOT_ADD',
      draft: {
        docKey,
        docUrl: url,
        paperId: null,
        kind: 'sticky',
        anchor: { kind: 'text', blockIndex, quote: '', prefix: '', suffix: '' },
        text: '',
        color: DEFAULT_ANNOTATION_COLOR,
        note: '',
      },
    });
    if (res.ok && res.annotation) setActiveId(res.annotation.id);
  }, [blockIndex, docKey, url]);

  const deleteAnnotation = useCallback((id: string) => {
    void sendMessage({ type: 'ANNOT_DELETE', id });
    setActiveId((current) => (current === id ? null : current));
  }, []);

  return (
    <div className="reader-root">
      <ReaderToolbar
        title={title}
        page={blockIndex + 1}
        pageCount={blocks.length}
        pageNoun="block"
        hasOutline={ready && state.outline.length > 0}
        outlineOpen={outlineOpen}
        onToggleOutline={() => setOutlineOpen((v) => !v)}
        src={url}
        openOriginalLabel="Open original"
        noteMode={false}
        onToggleNoteMode={() => void addSticky()}
        notesOpen={notesOpen}
        annotationCount={docAnnotations.length}
        onToggleNotes={() => setPanel((current) => (current === 'notes' ? 'none' : 'notes'))}
      />
      <div className="reader-body">
        {ready && state.outline.length > 0 && outlineOpen && (
          <OutlineSidebar
            outline={state.outline}
            currentPage={blockIndex}
            onJump={(block) => viewportRef.current?.scrollToBlock(block)}
          />
        )}
        {state.status === 'loading' && <div className="reader-fallback">Loading article…</div>}
        {state.status === 'error' && (
          <div className="reader-fallback">
            <p>{state.message}</p>
            <button className="fc-primary-btn" onClick={() => void chrome.tabs.create({ url })}>
              Open the original page
            </button>
          </div>
        )}
        {ready && (
          <ArticleViewport
            blocks={blocks}
            annotations={docAnnotations}
            activeId={activeId}
            onActivate={setActiveId}
            onCreateHighlight={createHighlight}
            onProgress={onProgress}
            handleRef={viewportRef}
          />
        )}
        {ready && notesOpen && (
          <AnnotationsSidebar
            annotations={docAnnotations}
            emptyHint="Select text in the article to highlight it."
            onJump={(seq) => viewportRef.current?.scrollToBlock(seq)}
            onDelete={deleteAnnotation}
          />
        )}
      </div>
    </div>
  );
}
