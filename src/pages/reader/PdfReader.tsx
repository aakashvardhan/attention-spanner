import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { annotationDocKey, DEFAULT_ANNOTATION_COLOR, sortAnnotations } from '../../shared/annotations';
import { RelatedHighlight } from '../../shared/components/RelatedHighlight';
import { sendMessage } from '../../shared/messages';
import { useSettings } from '../../shared/hooks/useSettings';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { sourceForUrl } from '../../shared/llm/route';
import { fetchPaperMeta, paperMatchKey } from '../../shared/papers';
import { type PdfPosition } from '../../shared/pdf';
import { isPdfAnchored } from '../../shared/types';
import { headingForPage, sectionIndexAt, topLevel } from '../../shared/pdfOutline';
import { minutesLeft, timeLeftLabel, wordCounts } from '../../shared/readingAids';
import type { AnnotationColor, AnnotationRect, HighlightTag, Paper, ReadingPass } from '../../shared/types';
import { useChromeAwake } from './useChromeAwake';
import { useDriftNudge } from './useDriftNudge';
import { useFocusLineKey } from './useFocusLineKey';
import { usePdfDocument } from './usePdfDocument';
import { indexKnownRefs } from './citationLinks';
import { findFigureCaptions, type FigureKey } from './figures';
import { extractReferences, getPdfPageTexts, type ReferenceIndex } from './references';
import { AnnotationsSidebar } from './components/AnnotationsSidebar';
import { AskSheet } from './components/AskSheet';
import { OutlineRail, useSectionToast } from './components/OutlineRail';
import { OutlineSidebar } from './components/OutlineSidebar';
import { PdfViewport, type PdfSelection, type PdfViewportHandle } from './components/PdfViewport';
import { ReaderCapsule } from './components/ReaderCapsule';
import { ReaderToolbar } from './components/ReaderToolbar';
import { TrackPrompt, type PaperSeed } from './components/TrackPrompt';
import { PdfFindPanel } from './components/PdfFindPanel';
import { PassLock } from './components/PassLock';
import { ProvocationCard } from './components/ProvocationCard';
import { CounterpointCard } from './components/CounterpointCard';
import { socraticSystem } from '../../shared/llm/provoke';
import { TAG_COLOR } from '../../shared/thinking';
import { useProvocations, type MarginCard } from './useProvocations';

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

  // Saved on the paper; an untracked PDF holds it for the session.
  const [sessionPass, setSessionPass] = useState<ReadingPass>(1);
  const pass = paper?.pass ?? sessionPass;
  const onPass = useCallback(
    (next: ReadingPass) => {
      setSessionPass(next);
      if (paper) void sendMessage({ type: 'PAPER_UPDATE', id: paper.id, patch: { pass: next } });
    },
    [paper],
  );

  // #page=N (deck deep link) wins over the saved position.
  const hashPage = useMemo(() => Number(/page=(\d+)/.exec(location.hash)?.[1]) || 0, []);
  const [position, setPosition] = useState<PdfPosition>({ page: 1, offset: 0 });
  const [zoom, setZoom] = useState(1);
  // Closed by default: the rail on the left edge is the outline at rest.
  const [outlineOpen, setOutlineOpen] = useState(false);
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
    (page: number, rects: AnnotationRect[], text: string, color: AnnotationColor, note = '') => {
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
          note,
        },
      });
    },
    [docKey, src],
  );

  const [restored, setRestored] = useState(false);
  const provocations = useProvocations({
    docKey,
    paperId: paper?.id ?? null,
    pass,
    page: position.page,
    pageCount,
    pageTexts,
    outline,
    source: sourceForUrl(src),
    annotations: docAnnotations,
    paper,
    restored,
    jump: (page) => viewportRef.current?.scrollToPosition(page, 0),
  });
  const { raiseForSelection } = provocations;

  // A tagged or questioned selection: highlight it, then the margin asks why.
  const highlightSelection = useCallback(
    async (sel: PdfSelection, tag: HighlightTag | null, ask: boolean) => {
      let first: { id: string; page: number } | null = null;
      for (const [page, rects] of sel.byPage) {
        const res = await sendMessage({
          type: 'ANNOT_ADD',
          draft: {
            docKey,
            docUrl: src,
            paperId: live.current.paper?.id ?? null,
            kind: 'highlight',
            anchor: { kind: 'pdf', page, rects, x: 0, y: 0 },
            text: sel.text,
            color: tag ? TAG_COLOR[tag] : DEFAULT_ANNOTATION_COLOR,
            note: '',
            ...(tag ? { tag } : {}),
          },
        });
        if (!first && res.ok && res.annotation) first = { id: res.annotation.id, page };
      }
      if (ask && first) raiseForSelection({ annotationId: first.id, page: first.page, text: sel.text, tag });
    },
    [docKey, src, raiseForSelection],
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
    (force = false, hidden = false) => {
      const l = live.current;
      if (!l.paper || !l.restored || l.pageCount === 0) return;
      const now = Date.now();
      if (!force && now - l.lastSentAt < PROGRESS_THROTTLE_MS) return;
      const since = l.lastSentAt;
      l.lastSentAt = now;
      void sendMessage({
        type: 'PAPER_READER_PROGRESS',
        paperId: l.paper.id,
        pdfUrl: src,
        page: l.position.page,
        pageCount: l.pageCount,
        offset: l.position.offset,
        leftOff: l.leftOffFor(l.position.page),
        // Credit at most one throttle window, as ArticleReader does, so a
        // reader left open in the background can't bank hours of reading.
        activeSecondsDelta: since === 0 ? 0 : Math.min((now - since) / 1000, PROGRESS_THROTTLE_MS / 1000),
        hidden,
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
    setRestored(true);
  }, []);

  // Leaving the tab (or closing it) flushes the latest position immediately.
  useEffect(() => {
    const onVisibility = () => {
      // Hidden starts the come-back nudge; visible again calls it off.
      sendProgress(true, document.visibilityState === 'hidden');
    };
    const onPageHide = () => sendProgress(true, true);
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
  // A notice over the page has to be closable; this one says something once.
  const [scanDismissed, setScanDismissed] = useState(false);
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
  // Top-level sections only: the rail is for orientation, not navigation depth.
  const sections = useMemo(() => topLevel(outline), [outline]);
  const sectionIndex = sectionIndexAt(sections, position.page);
  const sectionToast = useSectionToast(sections, sectionIndex);
  const focusLine = useFocusLineKey();
  const drift = useDriftNudge(
    position,
    (p) => headingForPage(outline, p.page) ?? `page ${p.page}`,
    (p) => viewportRef.current?.scrollToPosition(p.page, p.offset),
  );
  const awake = useChromeAwake(panel !== 'none' || noteMode || outlineOpen);

  return (
    <div
      className="reader-root"
      data-night={settings.readerNight || undefined}
      data-chrome={awake ? 'awake' : 'asleep'}
      data-focus-line={focusLine || undefined}
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
        openCount={provocations.open.length}
        onNextOpen={provocations.nextOpen}
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
              initialPosition={hashPage ? { page: hashPage, offset: 0 } : paper?.pdf ? { page: paper.pdf.page, offset: paper.pdf.offset } : null}
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
              docKey={docKey}
              source={sourceForUrl(src)}
              lockAfterPage={provocations.lock?.page ?? null}
              selectionMode="tags"
              onTag={(sel, tag) => void highlightSelection(sel, tag, tag !== null)}
              onQuestion={(sel) => void highlightSelection(sel, null, true)}
            />
            {provocations.margin && <Margin card={provocations.margin} actions={provocations.card} />}
            {provocations.lock && (
              <PassLock
                key={provocations.lock.page}
                question={provocations.lock.question}
                onContinue={provocations.lock.onContinue}
                onUnsure={provocations.lock.onUnsure}
              />
            )}
            <RelatedHighlight docKey={docKey} />
            {looksScanned && !scanDismissed && (
              <div className="reader-toast reader-scan-toast" role="status">
                <span>
                  This looks like a scanned PDF. Search, highlighting, and document Q&A may be limited until it has OCR
                  text.
                </span>
                <button type="button" onClick={() => setScanDismissed(true)}>
                  Dismiss
                </button>
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
            {focusLine && <div className="reader-focus-band" aria-hidden="true" />}
            {!outlineOpen && (
              <OutlineRail
                sections={sections}
                current={sectionIndex}
                onJump={(page) => viewportRef.current?.scrollToPosition(page, 0)}
              />
            )}
            <ReaderCapsule
              label={capsuleLabel}
              // While locked the capsule shows only where you are.
              message={provocations.lock ? null : (sectionToast ?? drift?.message ?? null)}
              action={drift && !sectionToast && !provocations.lock ? { label: 'Back', run: drift.back } : null}
              pass={pass}
              onPass={onPass}
              prompt={provocations.capsulePrompt}
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
            system={socraticSystem()}
            thread={false}
            onJump={(index) => viewportRef.current?.scrollToPosition(index + 1, 0)}
            onClose={() => setPanel('none')}
          />
        )}
        {ready && findOpen && <PdfFindPanel pages={pageTexts} onJump={(page) => viewportRef.current?.scrollToPosition(page, 0)} onClose={() => setPanel('none')} />}
      </div>
    </div>
  );
}

/** The one margin card: a question, then (once answered) a counterpoint or a breakdown. */
function Margin({
  card,
  actions,
}: {
  card: MarginCard;
  actions: ReturnType<typeof useProvocations>['card'];
}) {
  if (!card.question) return null;
  let body;
  if (card.answer === null) {
    body = (
      <ProvocationCard
        key={card.id}
        kicker={card.kicker}
        question={card.question}
        tags={card.kind === 'highlight' && !card.tag}
        placeholder="In one line, your own words"
        actionLabel={card.kind === 'highlight' ? 'Save reason' : 'Save answer'}
        onCommit={actions.commit}
        onSkip={actions.skip}
      >
        {card.kind === 'equation' && <code className="provoke-block">{card.passage}</code>}
      </ProvocationCard>
    );
  } else if (card.counterpoint) {
    body = (
      <CounterpointCard
        key={card.id}
        question={card.counterpoint.question}
        gap={card.counterpoint.gap}
        onDefend={(text, page) => actions.respond('defended', text, page)}
        onRevise={(text) => actions.respond('revised', text)}
      />
    );
  } else if (card.kind === 'equation') {
    body = (
      <section className="provoke-card" role="region" aria-label={card.kicker}>
        <p className="provoke-kicker">
          <span className="provoke-dot" aria-hidden="true" />
          {card.kicker}
        </p>
        <p className="provoke-reply">
          <span>You said</span>
          {card.answer}
        </p>
        {card.breakdown && (
          <ol className="provoke-breakdown">
            {card.breakdown.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ol>
        )}
        {card.canBreakDown && (
          <button type="button" className="ghost-btn" onClick={actions.breakDown}>
            Break it down
          </button>
        )}
      </section>
    );
  } else {
    return null;
  }
  return (
    <div className="provoke-margin">
      {body}
      {card.answer !== null && (
        <button type="button" className="provoke-skip provoke-close" onClick={actions.close}>
          Done
        </button>
      )}
    </div>
  );
}
