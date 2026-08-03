import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { annotationDocKey, DEFAULT_ANNOTATION_COLOR, sortAnnotations } from '../../shared/annotations';
import { sendMessage } from '../../shared/messages';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { paperMatchKey } from '../../shared/papers';
import { type PdfPosition } from '../../shared/pdf';
import { isPdfAnchored } from '../../shared/types';
import { headingForPage } from '../../shared/pdfOutline';
import type { AnnotationColor, AnnotationRect, Paper } from '../../shared/types';
import { usePdfDocument } from './usePdfDocument';
import { refKeysFrom } from '../../shared/docCitations';
import { indexKnownRefs } from './citationLinks';
import { extractReferences, getPdfPageTexts, getPdfText, type ReferenceIndex } from './references';
import { AnnotationsSidebar } from './components/AnnotationsSidebar';
import { AskPanel } from './components/AskPanel';
import { OutlineSidebar } from './components/OutlineSidebar';
import { RelatedPanel } from './components/RelatedPanel';
import { PdfViewport, type PdfViewportHandle } from './components/PdfViewport';
import { ReaderToolbar } from './components/ReaderToolbar';
import { TrackPrompt, type PaperSeed } from './components/TrackPrompt';
import { PdfFindPanel } from './components/PdfFindPanel';
import { AiOutlinePanel } from './components/AiOutlinePanel';

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

export function PdfReader({ src }: { src: string }) {
  const state = usePdfDocument(src);
  const [papers, papersLoaded] = useStorageValue('papers');
  const paper = findPaper(papers, src);

  const [position, setPosition] = useState<PdfPosition>({ page: 1, offset: 0 });
  const [zoom, setZoom] = useState(1);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const viewportRef = useRef<PdfViewportHandle>(null);

  // Annotations (highlights + sticky notes) for this document.
  const docKey = useMemo(() => annotationDocKey(src), [src]);
  const [allAnnotations] = useStorageValue('annotations');
  const docAnnotations = useMemo(
    () => sortAnnotations(allAnnotations.filter((a) => a.docKey === docKey)),
    [allAnnotations, docKey],
  );
  // The viewport positions annotations on a page box, so it only handles the
  // pdf-anchored ones. A text anchor here would mean a stored article
  // annotation collided on docKey — skip it rather than crash on the anchor.
  const pageAnnotations = useMemo(() => docAnnotations.filter(isPdfAnchored), [docAnnotations]);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [noteMode, setNoteMode] = useState(false);
  const [panel, setPanel] = useState<'none' | 'notes' | 'ask' | 'related' | 'find'>('none');
  // Lead with the generated research outline; the PDF's native bookmarks stay
  // one tab away and the generated result begins immediately on open.
  const [leftMode, setLeftMode] = useState<'outline' | 'ai'>('ai');
  const notesOpen = panel === 'notes';
  const askOpen = panel === 'ask';
  const relatedOpen = panel === 'related';
  const findOpen = panel === 'find';
  const aiOutlineOpen = outlineOpen && leftMode === 'ai';

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
  const [pageTexts, setPageTexts] = useState<string[] | null>(null);
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

  useEffect(() => {
    if (!doc) return;
    let alive = true;
    setPageTexts(null);
    void getPdfPageTexts(doc).then((texts) => alive && setPageTexts(texts)).catch(() => alive && setPageTexts([]));
    return () => { alive = false; };
  }, [doc]);

  // Record what this document cites, so other documents can ask "who links
  // here". One write per open, keyed by docKey — the parse above already
  // happened, so this costs a message and nothing else.
  const docTitle = ready ? state.title : '';
  useEffect(() => {
    if (!references) return;
    void sendMessage({
      type: 'DOC_CITATIONS_INDEX',
      entry: {
        docKey,
        docUrl: src,
        title: docTitle || src,
        refKeys: refKeysFrom(references),
        indexedAt: Date.now(),
      },
    });
  }, [references, docKey, src, docTitle]);

  // Which of this document's citations point at something already in the
  // library. Rebuilt when either side changes, so tracking a paper lights up
  // its citations across every open reader without a reload.
  const [docCitations] = useStorageValue('docCitations');
  const knownRefs = useMemo(() => indexKnownRefs(papers, docCitations), [papers, docCitations]);

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
          docUrl: src,
          paperId: live.current.paper?.id ?? null,
          kind: 'highlight',
          anchor: { kind: 'pdf', page, rects, x: 0, y: 0 },
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
          docUrl: src,
          paperId: live.current.paper?.id ?? null,
          kind: 'sticky',
          anchor: { kind: 'pdf', page, rects: [], x, y },
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

  // Stable identity so AskPanel's loader effect doesn't refire each render
  const getPdfTextForAsk = useCallback(
    async () => (ready ? getPdfText(state.doc) : ''),
    [ready, ready ? state.doc : null],
  );

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
  const looksScanned = pageTexts !== null && pageTexts.join('').replace(/\s/g, '').length < 200;

  return (
    <div className="reader-root">
      <ReaderToolbar
        title={title}
        page={position.page}
        pageCount={pageCount}
        onPageJump={(page) => viewportRef.current?.scrollToPosition(page, 0)}
        zoom={zoom}
        onZoom={setZoom}
        hasOutline={ready}
        outlineOpen={outlineOpen}
        onToggleOutline={() => setOutlineOpen((v) => !v)}
        src={src}
        noteMode={noteMode}
        onToggleNoteMode={() => setNoteMode((v) => !v)}
        notesOpen={notesOpen}
        annotationCount={docAnnotations.length}
        onToggleNotes={() => setPanel((current) => (current === 'notes' ? 'none' : 'notes'))}
        askOpen={askOpen}
        onToggleAsk={() => setPanel((current) => (current === 'ask' ? 'none' : 'ask'))}
        relatedOpen={relatedOpen}
        onToggleRelated={() => setPanel((current) => (current === 'related' ? 'none' : 'related'))}
        findOpen={findOpen}
        onToggleFind={() => setPanel((current) => (current === 'find' ? 'none' : 'find'))}
        aiOutlineOpen={aiOutlineOpen}
        onToggleAiOutline={() => {
          if (leftMode === 'ai' && outlineOpen) {
            setOutlineOpen(false);
          } else {
            setLeftMode('ai');
            setOutlineOpen(true);
          }
        }}
      />
      {ready && papersLoaded && !paper && (
        <TrackPrompt src={src} suggestedTitle={state.title} getSeed={getSeed} />
      )}
      {ready && looksScanned && (
        <div className="reader-scan-notice">
          This looks like a scanned PDF. Search, highlighting, and document Q&A may be limited until it has OCR text.
        </div>
      )}
      {noteMode && (
        <div className="reader-mode-banner" role="status">
          <span>Click anywhere on a page to place your note.</span>
          <button type="button" onClick={() => setNoteMode(false)}>Cancel</button>
          <kbd>Esc</kbd>
        </div>
      )}
      <div className="reader-body">
        {ready && outlineOpen && (outline.length > 0 || leftMode === 'ai') && (
          <OutlineSidebar
            outline={outline}
            currentPage={position.page}
            onJump={(page) => viewportRef.current?.scrollToPosition(page, 0)}
            activeTab={leftMode}
            onTabChange={setLeftMode}
            aiOutline={<AiOutlinePanel embedded title={title} pageTexts={pageTexts} bookmarks={outline} onJump={(page) => viewportRef.current?.scrollToPosition(page, 0)} />}
          />
        )}
        {state.status === 'loading' && (
          <div className="reader-fallback" role="status" aria-live="polite">
            <span className="reader-loading-spinner" aria-hidden="true" />
            <p>Preparing your document…</p>
          </div>
        )}
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
            annotations={pageAnnotations}
            activeId={activeAnnotationId}
            onActivate={setActiveAnnotationId}
            noteMode={noteMode}
            onCreateHighlight={createHighlight}
            onPlaceSticky={(page, x, y) => void placeSticky(page, x, y)}
            onUpdateNote={updateAnnotationNote}
            onUpdateColor={updateAnnotationColor}
            onDeleteAnnotation={deleteAnnotation}
            references={references}
            known={knownRefs}
          />
        )}
        {ready && papersLoaded && notesOpen && (
          <AnnotationsSidebar
            annotations={docAnnotations}
            labelFor={(page) => `Page ${page}`}
            emptyHint="Select text in the PDF to highlight it."
            onJump={jumpToAnnotation}
            onDelete={deleteAnnotation}
          />
        )}
        {ready && relatedOpen && (
          <RelatedPanel
            docKey={docKey}
            paper={paper}
            references={references}
            known={knownRefs}
            onClose={() => setPanel('none')}
          />
        )}
        {ready && findOpen && <PdfFindPanel pages={pageTexts} onJump={(page) => viewportRef.current?.scrollToPosition(page, 0)} onClose={() => setPanel('none')} />}
        {ready && askOpen && (
          <AskPanel
            getText={getPdfTextForAsk}
            title={title}
            position={position.page}
            total={pageCount}
            noun="paper"
            src={src}
          />
        )}
      </div>
    </div>
  );
}
