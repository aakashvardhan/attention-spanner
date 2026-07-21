import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { annotationDocKey, DEFAULT_ANNOTATION_COLOR, sortAnnotations } from '../../shared/annotations';
import { sendMessage } from '../../shared/messages';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { paperMatchKey } from '../../shared/papers';
import { type PdfPosition } from '../../shared/pdf';
import { headingForPage } from '../../shared/pdfOutline';
import type { AnnotationColor, AnnotationRect, Paper } from '../../shared/types';
import { usePdfDocument } from './usePdfDocument';
import { extractReferences, type ReferenceIndex } from './references';
import { AnnotationsSidebar } from './components/AnnotationsSidebar';
import { AskPanel } from './components/AskPanel';
import { OutlineSidebar } from './components/OutlineSidebar';
import { PdfViewport, type PdfViewportHandle } from './components/PdfViewport';
import { ReaderToolbar } from './components/ReaderToolbar';
import { TrackPrompt, type PaperSeed } from './components/TrackPrompt';

/** One progress write at most every 5s; position changes in between are dropped. */
const PROGRESS_THROTTLE_MS = 5_000;

/** The stored paper this PDF belongs to, by URL identity (abs/pdf variants collapse). */
function findPaper(papers: Paper[], src: string): Paper | null {
  const key = paperMatchKey(src);
  if (!key) return null;
  return (
    papers.find(
      (p) => paperMatchKey(p.url) === key || (p.pdf && paperMatchKey(p.pdf.url) === key),
    ) ?? null
  );
}

export function Reader() {
  const src = new URLSearchParams(location.search).get('src') ?? '';
  const state = usePdfDocument(src);
  const [papers, papersLoaded] = useStorageValue('papers');
  const paper = findPaper(papers, src);

  const [position, setPosition] = useState<PdfPosition>({ page: 1, offset: 0 });
  const [zoom, setZoom] = useState(1);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const viewportRef = useRef<PdfViewportHandle>(null);

  // Annotations (highlights + sticky notes) for this document.
  const docKey = useMemo(() => annotationDocKey(src), [src]);
  const [allAnnotations] = useStorageValue('pdfAnnotations');
  const docAnnotations = useMemo(
    () => sortAnnotations(allAnnotations.filter((a) => a.docKey === docKey)),
    [allAnnotations, docKey],
  );
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [noteMode, setNoteMode] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);

  useEffect(() => {
    if (!noteMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNoteMode(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [noteMode]);

  const jumpToAnnotation = useCallback((page: number, offset: number) => {
    viewportRef.current?.scrollToPosition(page, offset);
  }, []);

  const ready = state.status === 'ready';
  const pageCount = ready ? state.pageSizes.length : 0;
  const outline = ready ? state.outline : [];

  // Bibliography index for citation hover previews. Extracted after the doc is
  // ready — off the first-paint path, so the PDF shows immediately and markers
  // light up once it resolves.
  const doc = ready ? state.doc : null;
  const [references, setReferences] = useState<ReferenceIndex | null>(null);
  useEffect(() => {
    if (!doc) return;
    let alive = true;
    setReferences(null);
    void extractReferences(doc).then((index) => {
      if (alive) setReferences(index);
    });
    return () => {
      alive = false;
    };
  }, [doc]);

  const leftOffFor = useCallback(
    (page: number) => headingForPage(outline, page) ?? `Page ${page} of ${pageCount}`,
    [outline, pageCount],
  );

  // Everything the throttled sender needs, without re-subscribing listeners.
  const live = useRef({ paper, position, pageCount, leftOffFor, restored: false, lastSentAt: 0 });
  live.current.paper = paper;
  live.current.pageCount = pageCount;
  live.current.leftOffFor = leftOffFor;

  const createHighlight = useCallback(
    (page: number, rects: AnnotationRect[], text: string, color: AnnotationColor) => {
      void sendMessage({
        type: 'ANNOT_ADD',
        draft: {
          docKey,
          pdfUrl: src,
          paperId: live.current.paper?.id ?? null,
          kind: 'highlight',
          page,
          rects,
          x: 0,
          y: 0,
          text,
          color,
          note: '',
        },
      });
    },
    [docKey, src],
  );

  const placeSticky = useCallback(
    async (page: number, x: number, y: number) => {
      setNoteMode(false);
      const res = await sendMessage({
        type: 'ANNOT_ADD',
        draft: {
          docKey,
          pdfUrl: src,
          paperId: live.current.paper?.id ?? null,
          kind: 'sticky',
          page,
          rects: [],
          x,
          y,
          text: '',
          color: DEFAULT_ANNOTATION_COLOR,
          note: '',
        },
      });
      if (res.ok && res.annotation) setActiveAnnotationId(res.annotation.id);
    },
    [docKey, src],
  );

  const updateAnnotationNote = useCallback((id: string, note: string) => {
    void sendMessage({ type: 'ANNOT_UPDATE', id, patch: { note } });
  }, []);

  const updateAnnotationColor = useCallback((id: string, color: AnnotationColor) => {
    void sendMessage({ type: 'ANNOT_UPDATE', id, patch: { color } });
  }, []);

  const deleteAnnotation = useCallback((id: string) => {
    void sendMessage({ type: 'ANNOT_DELETE', id });
    setActiveAnnotationId((current) => (current === id ? null : current));
  }, []);

  const sendProgress = useCallback(
    (force = false) => {
      const l = live.current;
      if (!l.paper || !l.restored || l.pageCount === 0) return;
      const now = Date.now();
      if (!force && now - l.lastSentAt < PROGRESS_THROTTLE_MS) return;
      l.lastSentAt = now;
      void sendMessage({
        type: 'PAPER_READER_PROGRESS',
        paperId: l.paper.id,
        pdfUrl: src,
        page: l.position.page,
        pageCount: l.pageCount,
        offset: l.position.offset,
        leftOff: l.leftOffFor(l.position.page),
      });
    },
    [src],
  );

  const onPosition = useCallback(
    (pos: PdfPosition) => {
      setPosition(pos);
      live.current.position = pos;
      sendProgress();
    },
    [sendProgress],
  );

  // Progress writes stay off until the viewport has applied the saved
  // position, so a stale page-1 report never lands before the resume scroll.
  const onRestored = useCallback(() => {
    const stored = live.current.paper?.pdf;
    if (stored) {
      const pos = { page: stored.page, offset: stored.offset };
      setPosition(pos);
      live.current.position = pos;
    }
    live.current.restored = true;
  }, []);

  // Leaving the tab (or closing it) flushes the latest position immediately.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') sendProgress(true);
    };
    const onPageHide = () => sendProgress(true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [sendProgress]);

  const getSeed = useCallback((): PaperSeed => {
    const l = live.current;
    const pdf = { url: src, page: l.position.page, pageCount: l.pageCount, offset: l.position.offset };
    return {
      progressPercent: 0, // the first progress write ratchets it up
      leftOff: l.leftOffFor(l.position.page),
      pdf,
    };
  }, [src]);

  const title =
    paper?.title || (ready ? state.title : '') || decodeURIComponent(src.split('/').pop() ?? 'PDF');

  if (!src) {
    return (
      <div className="reader-fallback">
        <p>No PDF to show — open one from the papers page or navigate to a PDF link.</p>
      </div>
    );
  }

  return (
    <div className="reader-root">
      <ReaderToolbar
        title={title}
        page={position.page}
        pageCount={pageCount}
        zoom={zoom}
        onZoom={setZoom}
        hasOutline={outline.length > 0}
        outlineOpen={outlineOpen}
        onToggleOutline={() => setOutlineOpen((v) => !v)}
        src={src}
        noteMode={noteMode}
        onToggleNoteMode={() => setNoteMode((v) => !v)}
        notesOpen={notesOpen}
        annotationCount={docAnnotations.length}
        onToggleNotes={() => setNotesOpen((v) => !v)}
        askOpen={askOpen}
        onToggleAsk={() => setAskOpen((v) => !v)}
      />
      {ready && papersLoaded && !paper && (
        <TrackPrompt src={src} suggestedTitle={state.title} getSeed={getSeed} />
      )}
      <div className="reader-body">
        {ready && outline.length > 0 && outlineOpen && (
          <OutlineSidebar
            outline={outline}
            currentPage={position.page}
            onJump={(page) => viewportRef.current?.scrollToPosition(page, 0)}
          />
        )}
        {state.status === 'loading' && <div className="reader-fallback">Loading PDF…</div>}
        {state.status === 'error' && (
          <div className="reader-fallback">
            <p>{state.message}</p>
            <button
              className="fc-primary-btn"
              onClick={() => void sendMessage({ type: 'READER_OPEN_NATIVE', url: src })}
            >
              Open in Chrome's viewer
            </button>
          </div>
        )}
        {ready && papersLoaded && (
          <PdfViewport
            doc={state.doc}
            pageSizes={state.pageSizes}
            zoom={zoom}
            initialPosition={paper?.pdf ? { page: paper.pdf.page, offset: paper.pdf.offset } : null}
            onRestored={onRestored}
            onPosition={onPosition}
            handleRef={viewportRef}
            annotations={docAnnotations}
            activeId={activeAnnotationId}
            onActivate={setActiveAnnotationId}
            noteMode={noteMode}
            onCreateHighlight={createHighlight}
            onPlaceSticky={(page, x, y) => void placeSticky(page, x, y)}
            onUpdateNote={updateAnnotationNote}
            onUpdateColor={updateAnnotationColor}
            onDeleteAnnotation={deleteAnnotation}
            references={references}
          />
        )}
        {ready && papersLoaded && notesOpen && (
          <AnnotationsSidebar
            annotations={docAnnotations}
            onJump={jumpToAnnotation}
            onDelete={deleteAnnotation}
          />
        )}
        {ready && askOpen && (
          <AskPanel doc={state.doc} title={title} currentPage={position.page} pageCount={pageCount} />
        )}
      </div>
    </div>
  );
}
