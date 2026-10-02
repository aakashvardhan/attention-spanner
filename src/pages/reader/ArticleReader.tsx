import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { annotationDocKey, sortAnnotations } from '../../shared/annotations';
import { DEFAULT_ANNOTATION_COLOR } from '../../shared/annotations';
import { sendMessage } from '../../shared/messages';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { RecapCard } from '../../shared/components/RecapCard';
import { RelatedHighlight } from '../../shared/components/RelatedHighlight';
import type { TextAnchor } from '../../shared/textAnchor';
import { minutesLeft, timeLeftLabel, wordCounts } from '../../shared/readingAids';
import { headingForPage, sectionIndexAt, topLevel } from '../../shared/pdfOutline';
import { normalizeUrl } from '../../shared/urlNormalize';
import type { AnnotationColor } from '../../shared/types';
import { AnnotationsSidebar } from './components/AnnotationsSidebar';
import { AskSheet } from './components/AskSheet';
import { ArticleViewport, type ArticleViewportHandle } from './components/ArticleViewport';
import { OutlineRail, useSectionToast } from './components/OutlineRail';
import { OutlineSidebar } from './components/OutlineSidebar';
import { ReaderCapsule } from './components/ReaderCapsule';
import { ReaderToolbar } from './components/ReaderToolbar';
import { useChromeAwake } from './useChromeAwake';
import { useDriftNudge } from './useDriftNudge';
import { useFocusLineKey } from './useFocusLineKey';
import { blockTexts, useArticleDocument } from './useArticleDocument';

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
  // Closed by default: the rail on the left edge is the outline at rest.
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [panel, setPanel] = useState<'none' | 'notes' | 'ask'>('none');
  const notesOpen = panel === 'notes';
  const [blockIndex, setBlockIndex] = useState(0);
  const [percent, setPercent] = useState(0);
  const viewportRef = useRef<ArticleViewportHandle>(null);

  const ready = state.status === 'ready';
  const blocks = ready ? state.blocks : [];
  const title = ready ? state.title : url;
  const passages = useMemo(() => (state.status === 'ready' ? blockTexts(state.blocks) : null), [state]);

  // How far this article had been read before this open. Taken once: the live
  // value climbs as you scroll, and the recap is about the earlier session.
  const progressKey = useMemo(() => normalizeUrl(url), [url]);
  const [readingProgress, progressLoaded] = useStorageValue('readingProgress');
  // An article that came in through a feed is public; any other page might be
  // behind a login, so it is treated as private (llm/route.ts).
  const [cachedItems] = useStorageValue('cachedItems');
  const fromFeed = useMemo(
    () => cachedItems.some((item) => item.normalizedLink === progressKey),
    [cachedItems, progressKey],
  );
  const [openedAtPercent, setOpenedAtPercent] = useState<number | null>(null);
  if (openedAtPercent === null && progressLoaded) {
    const entry = readingProgress[progressKey];
    setOpenedAtPercent(entry && entry.completedAt === null ? entry.maxPercent : 0);
  }

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
      setPercent(percent);
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

  // Status for the capsule: how far through, and minutes left from the words ahead.
  const counts = useMemo(() => (passages ? wordCounts(passages) : null), [passages]);
  const capsuleLabel = [`${Math.round(percent)}%`, timeLeftLabel(minutesLeft(counts, blockIndex, 0))]
    .filter(Boolean)
    .join(' · ');
  // Top-level headings only; an article outline's `page` is a block index.
  const sections = useMemo(() => (state.status === 'ready' ? topLevel(state.outline) : []), [state]);
  const sectionIndex = sectionIndexAt(sections, blockIndex);
  const sectionToast = useSectionToast(sections, sectionIndex);
  const focusLine = useFocusLineKey();
  const drift = useDriftNudge(
    blockIndex,
    (b) => headingForPage(state.status === 'ready' ? state.outline : [], b) ?? `${Math.round(percent)}%`,
    (b) => viewportRef.current?.scrollToBlock(b),
  );
  const awake = useChromeAwake(panel !== 'none' || outlineOpen);

  return (
    <div
      className="reader-root"
      data-chrome={awake ? 'awake' : 'asleep'}
      data-focus-line={focusLine || undefined}
    >
      <ReaderToolbar
        title={title}
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
        askOpen={panel === 'ask'}
        onToggleAsk={() => setPanel((current) => (current === 'ask' ? 'none' : 'ask'))}
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
          // The cards float over the text column only, never over a side panel.
          <div className="reader-main">
            <ArticleViewport
              blocks={blocks}
              annotations={docAnnotations}
              activeId={activeId}
              onActivate={setActiveId}
              onCreateHighlight={createHighlight}
              onProgress={onProgress}
              focusBlock={blockIndex}
              handleRef={viewportRef}
            />
            {openedAtPercent !== null && (
              <RecapCard
                progressKey={progressKey}
                percent={openedAtPercent}
                passages={passages}
                source="web"
              />
            )}
            <RelatedHighlight docKey={docKey} />
            {!outlineOpen && (
              <OutlineRail
                sections={sections}
                current={sectionIndex}
                onJump={(block) => viewportRef.current?.scrollToBlock(block)}
              />
            )}
            <ReaderCapsule
              label={capsuleLabel}
              message={sectionToast ?? drift?.message ?? null}
              action={drift && !sectionToast ? { label: 'Back', run: drift.back } : null}
              progress={percent / 100}
              page={blockIndex + 1}
              pageCount={blocks.length}
              pageNoun="block"
              onPageJump={(block) => viewportRef.current?.scrollToBlock(block - 1)}
            />
          </div>
        )}
        {panel === 'ask' && (
          <AskSheet
            passages={passages}
            source={fromFeed ? 'rss' : 'web'}
            passageNoun="passage"
            onJump={(index) => viewportRef.current?.scrollToBlock(index)}
            onClose={() => setPanel('none')}
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
