import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { annotationDocKey, DEFAULT_ANNOTATION_COLOR, sortAnnotations } from '../../shared/annotations';
import { RecapCard } from '../../shared/components/RecapCard';
import { RelatedHighlight } from '../../shared/components/RelatedHighlight';
import { sendMessage } from '../../shared/messages';
import { useSettings } from '../../shared/hooks/useSettings';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { sourceForUrl } from '../../shared/llm/route';
import { fetchPaperMeta, paperMatchKey } from '../../shared/papers';
import { type PdfPosition } from '../../shared/pdf';
import { isPdfAnchored } from '../../shared/types';
import { headingForPage } from '../../shared/pdfOutline';
import { minutesLeft, timeLeftLabel, wordCounts } from '../../shared/readingAids';
import type { AnnotationColor, AnnotationRect, Paper } from '../../shared/types';
import { useChromeAwake } from './useChromeAwake';
import { usePdfDocument } from './usePdfDocument';
import { indexKnownRefs } from './citationLinks';
import { findFigureCaptions, type FigureKey } from './figures';
import { extractReferences, getPdfPageTexts, type ReferenceIndex } from './references';
import { AnnotationsSidebar } from './components/AnnotationsSidebar';
import { AskSheet } from './components/AskSheet';
import { OutlineSidebar } from './components/OutlineSidebar';
import { PdfViewport, type PdfViewportHandle } from './components/PdfViewport';
import { ReaderCapsule } from './components/ReaderCapsule';
import { ReaderToolbar } from './components/ReaderToolbar';
import { TrackPrompt, type PaperSeed } from './components/TrackPrompt';
import { PdfFindPanel } from './components/PdfFindPanel';

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
  const [settings] = useSettings();

  // The paper's progress before this open, captured once (see ArticleReader).
  const [openedAt, setOpenedAt] = useState<{ key: string; percent: number } | null>(null);
  if (openedAt === null && papersLoaded) {
    setOpenedAt(
      paper && paper.status !== 'read'
        ? { key: `paper:${paper.id}`, percent: paper.progressPercent }
        : { key: '', percent: 0 },
    );
  }

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
  const [panel, setPanel] = useState<'none' | 'notes' | 'find' | 'ask'>('none');
  // Lead with the generated research outline; the PDF's native bookmarks stay
  // one tab away and the generated result begins immediately on open.
  const notesOpen = panel === 'notes';
  const findOpen = panel === 'find';

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

  // Figure/table captions, so in-text mentions can jump to them.
  const [figures, setFigures] = useState<Map<FigureKey, PdfPosition> | null>(null);
  useEffect(() => {
    if (!doc) return;
    let alive = true;
    setFigures(null);
    void findFigureCaptions(doc).then((found) => alive && setFigures(found)).catch(() => undefined);
    return () => { alive = false; };
  }, [doc]);

  useEffect(() => {
    if (!doc) return;
    let alive = true;
    setPageTexts(null);
    void getPdfPageTexts(doc).then((texts) => alive && setPageTexts(texts)).catch(() => alive && setPageTexts([]));
    return () => { alive = false; };
  }, [doc]);

  // Which of this document's citations point at something already in the
  // library. Rebuilt when either side changes, so tracking a paper lights up
  // its citations across every open reader without a reload.
  const knownRefs = useMemo(() => indexKnownRefs(papers), [papers]);

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

  // A tracked paper cites from its record; otherwise look the PDF up, since
  // its own metadata rarely has more than a title (often not even that).
  const apiKey = settings.semanticScholarApiKey;
  const getCitation = useCallback(async () => {
    if (live.current.paper) return live.current.paper;
    const res = await fetchPaperMeta(src, apiKey);
    return res.ok ? res.meta : { title, authors: '', venue: '', year: null, url: src };
  }, [src, apiKey, title]);
  const looksScanned = pageTexts !== null && pageTexts.join('').replace(/\s/g, '').length < 200;

  // Status for the capsule: page, and minutes left from the words still ahead.
  const counts = useMemo(() => (pageTexts ? wordCounts(pageTexts) : null), [pageTexts]);
  const capsuleLabel = [
    `p. ${position.page} of ${pageCount}`,
    timeLeftLabel(minutesLeft(counts, position.page - 1, position.offset)),
  ]
    .filter(Boolean)
    .join(' · ');
  const progress = pageCount > 0 ? (position.page - 1 + position.offset) / pageCount : 0;
  const awake = useChromeAwake(panel !== 'none' || noteMode || outlineOpen);

  return (
    <div
      className="reader-root"
      data-night={settings.readerNight || undefined}
      data-chrome={awake ? 'awake' : 'asleep'}
    >
      <ReaderToolbar
        title={title}
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
        findOpen={findOpen}
        onToggleFind={() => setPanel((current) => (current === 'find' ? 'none' : 'find'))}
        askOpen={panel === 'ask'}
        onToggleAsk={() => setPanel((current) => (current === 'ask' ? 'none' : 'ask'))}
        citation={getCitation}
      />
      <div className="reader-body">
        {ready && outlineOpen && (
          <OutlineSidebar
            outline={outline}
            currentPage={position.page}
            onJump={(page) => viewportRef.current?.scrollToPosition(page, 0)}
            ai={{ cacheKey: `outline:${docKey}`, passages: pageTexts, source: sourceForUrl(src) }}
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
          // The cards float over the page column only, never over a side panel.
          <div className="reader-main">
            <PdfViewport
              doc={state.doc}
              pageSizes={state.pageSizes}
              zoom={zoom}
              onZoom={setZoom}
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
              figures={figures}
            />
            {openedAt?.key && (
              <RecapCard
                progressKey={openedAt.key}
                percent={openedAt.percent}
                passages={pageTexts}
                source={sourceForUrl(src)}
              />
            )}
            <RelatedHighlight docKey={docKey} />
            {looksScanned && (
              <div className="reader-toast" role="status">
                This looks like a scanned PDF. Search, highlighting, and document Q&A may be limited until it has OCR text.
              </div>
            )}
            {noteMode && (
              <div className="reader-toast reader-mode-banner" role="status">
                <span>Click anywhere on a page to place your note.</span>
                <button type="button" onClick={() => setNoteMode(false)}>
                  Cancel
                </button>
                <kbd>Esc</kbd>
              </div>
            )}
            <ReaderCapsule
              label={capsuleLabel}
              progress={progress}
              page={position.page}
              pageCount={pageCount}
              pageNoun="page"
              onPageJump={(page) => viewportRef.current?.scrollToPosition(page, 0)}
              zoom={zoom}
              onZoom={setZoom}
            >
              {!paper && <TrackPrompt src={src} suggestedTitle={state.title} getSeed={getSeed} />}
            </ReaderCapsule>
          </div>
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
        {ready && panel === 'ask' && (
          <AskSheet
            passages={pageTexts}
            source={sourceForUrl(src)}
            passageNoun="page"
            onJump={(index) => viewportRef.current?.scrollToPosition(index + 1, 0)}
            onClose={() => setPanel('none')}
          />
        )}
        {ready && findOpen && <PdfFindPanel pages={pageTexts} onJump={(page) => viewportRef.current?.scrollToPosition(page, 0)} onClose={() => setPanel('none')} />}
      </div>
    </div>
  );
}
