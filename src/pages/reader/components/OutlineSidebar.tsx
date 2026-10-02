import { useEffect, useState } from 'react';
import { AiNote } from '../../../shared/components/AiNote';
import { useAi } from '../../../shared/hooks/useAi';
import { outlineRequest, parseOutline } from '../../../shared/llm/outline';
import type { AiSource } from '../../../shared/llm/route';
import type { FlatOutlineItem } from '../../../shared/pdfOutline';

/** Index of the heading the reader is currently "in" (mirrors headingForPage). */
function activeIndex(outline: FlatOutlineItem[], page: number): number {
  let best = -1;
  for (let i = 0; i < outline.length; i++) {
    if (outline[i].page <= page && (best === -1 || outline[i].page >= outline[best].page)) best = i;
  }
  return best;
}

/** What the AI outline needs; absent on surfaces without one (articles). */
export interface AiOutlineSource {
  /** Cache key for the generated outline (the document key) */
  cacheKey: string;
  /** One passage per page; null while the text is still loading */
  passages: string[] | null;
  source: AiSource;
}

export function OutlineSidebar({
  outline,
  currentPage,
  onJump,
  ai,
}: {
  outline: FlatOutlineItem[];
  currentPage: number;
  onJump: (page: number) => void;
  ai?: AiOutlineSource;
}) {
  const active = activeIndex(outline, currentPage);
  const [tab, setTab] = useState<'ai' | 'contents'>(ai ? 'ai' : 'contents');
  const showTabs = ai && outline.length > 0;

  return (
    <nav className="reader-outline">
      {showTabs ? (
        <div className="reader-outline-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'ai'} onClick={() => setTab('ai')}>
            AI outline
          </button>
          <button role="tab" aria-selected={tab === 'contents'} onClick={() => setTab('contents')}>
            Contents
          </button>
        </div>
      ) : (
        <h2>{ai ? 'AI outline' : 'Outline'}</h2>
      )}
      {/* Hidden rather than unmounted, so switching tabs doesn't abort a stream. */}
      {ai && (
        <div hidden={tab !== 'ai'}>
          <AiOutline {...ai} onJump={onJump} />
        </div>
      )}
      {outline.length > 0 && (
        <ul hidden={tab !== 'contents'}>
          {outline.map((item, i) => (
            <li key={i}>
              <button
                className={i === active ? 'reader-outline-item active' : 'reader-outline-item'}
                style={{ paddingLeft: 10 + item.level * 14 }}
                title={item.title}
                onClick={() => onJump(item.page)}
              >
                {item.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

/**
 * Generated on first open and cached per document, so it costs one model call
 * per paper. Each bullet jumps to the page it cites.
 */
function AiOutline({
  cacheKey,
  passages,
  source,
  onJump,
}: AiOutlineSource & { onJump: (page: number) => void }) {
  const ai = useAi();
  const { start } = ai;
  useEffect(() => {
    if (passages?.length) void start(outlineRequest({ key: cacheKey, passages, source }));
  }, [start, cacheKey, passages, source]);

  const { status, text } = ai.view;
  const bullets = status === 'done' || status === 'streaming' ? parseOutline(text, passages?.length ?? 0) : [];
  if (!passages) return <p className="reader-notes-empty">Reading the text…</p>;
  if (!bullets.length) {
    return (
      <AiNote
        view={ai.view}
        onStop={ai.stop}
        onApprove={ai.approve}
        onDismiss={ai.dismiss}
        onRetry={() => void start(outlineRequest({ key: cacheKey, passages, source }))}
      />
    );
  }
  const { route, model } = ai.view;
  return (
    <>
      <ul className="reader-ai-outline">
        {bullets.map((b, i) => (
          <li key={i}>
            <button
              className="reader-outline-item"
              disabled={b.page === null}
              onClick={() => b.page !== null && onJump(b.page)}
            >
              {b.text}
              {b.page !== null && <span className="reader-ai-outline-page">p. {b.page}</span>}
            </button>
          </li>
        ))}
      </ul>
      {route && (
        <small className="ai-note-chip" title={route.reason}>
          {route.target === 'claude' ? 'Cloud' : 'On device'}
          {model ? ` · ${model}` : ''}
        </small>
      )}
    </>
  );
}
