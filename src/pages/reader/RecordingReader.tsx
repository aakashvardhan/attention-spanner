import { useCallback, useMemo, useRef, useState } from 'react';
import {
  annotationDocKey,
  DEFAULT_ANNOTATION_COLOR,
  sortAnnotations,
} from '../../shared/annotations';
import { articleText, outlineOf } from '../../shared/articleExtract';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { sendMessage } from '../../shared/messages';
import { recordingDocUrl, sourceUrl, sourceUrlAt, timestampSeconds } from '../../shared/recordings';
import type { TextAnchor } from '../../shared/textAnchor';
import type { AnnotationColor } from '../../shared/types';
import { AnnotationsSidebar } from './components/AnnotationsSidebar';
import { ArticleViewport, type ArticleViewportHandle } from './components/ArticleViewport';
import { AskPanel } from './components/AskPanel';
import { OutlineSidebar } from './components/OutlineSidebar';
import { ReaderToolbar } from './components/ReaderToolbar';
import { recordingBlocks } from './recordingBlocks';

/**
 * A transcript in the same shell as articles and PDFs. The recording is read
 * live from storage rather than fetched, so a transcript still filling in
 * segment by segment can be opened and read while it grows.
 *
 * No PROGRESS_UPDATE here, unlike ArticleReader: time spent rereading your own
 * lecture is not reading an article, and crediting it would put transcripts in
 * the Continue list competing with things you actually left unfinished.
 */
export function RecordingReader({ id }: { id: string }) {
  const [recordings] = useStorageValue('recordings');
  const recording = useMemo(() => recordings.find((r) => r.id === id), [recordings, id]);

  const docUrl = useMemo(() => recordingDocUrl(id), [id]);
  const docKey = useMemo(() => annotationDocKey(docUrl), [docUrl]);

  const [allAnnotations] = useStorageValue('annotations');
  const docAnnotations = useMemo(
    () => sortAnnotations(allAnnotations.filter((a) => a.docKey === docKey)),
    [allAnnotations, docKey],
  );

  const [activeId, setActiveId] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [panel, setPanel] = useState<'none' | 'notes' | 'ask'>('none');
  const [actionsOpen, setActionsOpen] = useState(false);
  const notesOpen = panel === 'notes';
  const askOpen = panel === 'ask';
  const [blockIndex, setBlockIndex] = useState(0);
  const viewportRef = useRef<ArticleViewportHandle>(null);

  const blocks = useMemo(() => (recording ? recordingBlocks(recording) : []), [recording]);
  const outline = useMemo(
    () => outlineOf(blocks).map((h) => ({ title: h.title, level: h.level, page: h.blockIndex })),
    [blocks],
  );
  const title = recording?.title ?? 'Recording';
  const originalUrl = recording ? sourceUrl(recording.source) : undefined;

  const createHighlight = useCallback(
    (anchor: TextAnchor, text: string, color: AnnotationColor) => {
      void sendMessage({
        type: 'ANNOT_ADD',
        draft: {
          docKey,
          docUrl,
          paperId: null,
          kind: 'highlight',
          anchor: { kind: 'text', ...anchor },
          text,
          color,
          note: '',
        },
      });
    },
    [docKey, docUrl],
  );

  const addSticky = useCallback(async () => {
    const res = await sendMessage({
      type: 'ANNOT_ADD',
      draft: {
        docKey,
        docUrl,
        paperId: null,
        kind: 'sticky',
        anchor: { kind: 'text', blockIndex, quote: '', prefix: '', suffix: '' },
        text: '',
        color: DEFAULT_ANNOTATION_COLOR,
        note: '',
      },
    });
    if (res.ok && res.annotation) setActiveId(res.annotation.id);
  }, [blockIndex, docKey, docUrl]);

  const deleteAnnotation = useCallback((id: string) => {
    void sendMessage({ type: 'ANNOT_DELETE', id });
    setActiveId((current) => (current === id ? null : current));
  }, []);

  // The summary and action items go to the model too: they are the part already
  // phrased for retrieval, and they cost almost nothing next to the transcript.
  const getText = useCallback(async () => articleText(blocks), [blocks]);

  if (!recording) {
    return <div className="reader-fallback">That recording is gone.</div>;
  }

  const empty = blocks.length === 0;

  return (
    <div className="reader-root">
      <ReaderToolbar
        title={title}
        page={blockIndex + 1}
        pageCount={blocks.length}
        pageNoun="block"
        hasOutline={outline.length > 0}
        outlineOpen={outlineOpen}
        onToggleOutline={() => setOutlineOpen((v) => !v)}
        src={originalUrl}
        openOriginalLabel="Open source"
        noteMode={false}
        onToggleNoteMode={() => void addSticky()}
        notesOpen={notesOpen}
        annotationCount={docAnnotations.length}
        onToggleNotes={() => setPanel((current) => (current === 'notes' ? 'none' : 'notes'))}
        askOpen={askOpen}
        onToggleAsk={() => setPanel((current) => (current === 'ask' ? 'none' : 'ask'))}
        actionItemsCount={recording.actionItems.length}
        actionsOpen={actionsOpen}
        onToggleActions={() => setActionsOpen((open) => !open)}
      />
      <div className="reader-body">
        {outline.length > 0 && outlineOpen && (
          <OutlineSidebar
            outline={outline}
            currentPage={blockIndex}
            onJump={(block) => viewportRef.current?.scrollToBlock(block)}
          />
        )}
        {empty && (
          <div className="reader-fallback">
            {recording.status === 'failed' ? (
              <p>{recording.error || 'This recording failed.'}</p>
            ) : (
              <p>Nothing transcribed yet — the first segment lands a few minutes in.</p>
            )}
          </div>
        )}
        {!empty && (
          <>
            {recording.actionItems.length > 0 && actionsOpen && <RecordingActions items={recording.actionItems} onClose={() => setActionsOpen(false)} />}
            <ArticleViewport
              blocks={blocks}
              annotations={docAnnotations}
              activeId={activeId}
              onActivate={setActiveId}
              onCreateHighlight={createHighlight}
              onTimestampClick={
                originalUrl
                  ? (timestamp) => {
                      const seconds = timestampSeconds(timestamp);
                      const url = seconds === null ? undefined : sourceUrlAt(recording.source, seconds);
                      if (url) void chrome.tabs.create({ url });
                    }
                  : undefined
              }
              onProgress={(_percent, currentBlock) => setBlockIndex(currentBlock)}
              handleRef={viewportRef}
            />
          </>
        )}
        {!empty && notesOpen && (
          <AnnotationsSidebar
            annotations={docAnnotations}
            emptyHint="Select text in the transcript to highlight it."
            onJump={(seq) => viewportRef.current?.scrollToBlock(seq)}
            onDelete={deleteAnnotation}
          />
        )}
        {!empty && askOpen && (
          <AskPanel
            getText={getText}
            title={title}
            position={blockIndex + 1}
            total={blocks.length}
            noun="transcript"
          />
        )}
      </div>
    </div>
  );
}

/** Generated actions stay suggestions until the user deliberately creates a task. */
function RecordingActions({ items, onClose }: { items: string[]; onClose: () => void }) {
  const [added, setAdded] = useState<Set<number>>(() => new Set());

  const add = async (text: string, index: number) => {
    const result = await sendMessage({ type: 'ADD_TASK', text, source: 'recording' });
    if (result.ok) {
      setAdded((current) => new Set(current).add(index));
    }
  };

  return (
    <section className="recording-actions" aria-label="Suggested action items">
      <div className="recording-actions-head">
        <h2>Action items</h2>
        <span>Review before adding</span>
        <button className="ghost-btn" onClick={onClose} aria-label="Close action items">✕</button>
      </div>
      {items.map((item, index) => (
        <div className="recording-action" key={`${index}:${item}`}>
          <span>{item}</span>
          <button
            className="ghost-btn"
            disabled={added.has(index)}
            onClick={() => void add(item, index)}
          >
            {added.has(index) ? 'Added' : 'Add task'}
          </button>
        </div>
      ))}
    </section>
  );
}
