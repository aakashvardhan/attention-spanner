import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ANNOTATION_COLORS } from '../../../shared/annotations';
import type { ArticleBlock } from '../../../shared/articleExtract';
import { findTextAnchor, makeTextAnchor, type TextAnchor } from '../../../shared/textAnchor';
import type { Annotation, AnnotationColor } from '../../../shared/types';
import { isTextAnchored } from '../../../shared/types';
import { SelectionMenu } from './SelectionMenu';
import { Markdown } from '../../../shared/components/Markdown';

/** Rich source text is common in generated meeting summaries and imported
 * transcripts. Render it through the same safe Markdown + KaTeX pipeline as
 * the reader's Ask panel, but keep ordinary prose as native text so precise
 * text anchors and highlights remain unchanged. */
function hasRichSyntax(text: string): boolean {
  return /\$\$[\s\S]+?\$\$|\$(?!\s)[^\n$]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/.test(text);
}

/**
 * The article half of the reader. Peer to PdfViewport, and much smaller: no
 * canvas, no text layer, no zoom — the browser lays out the text and we only
 * have to know which block a selection landed in.
 *
 * Highlights are painted by splitting a block's text at the offsets the
 * anchors resolve to, so they survive reflow: nothing is positioned.
 */

export interface ArticleViewportHandle {
  /** Scroll a block to the top of the viewport (outline jumps, note jumps) */
  scrollToBlock: (blockIndex: number) => void;
}

interface ResolvedHit {
  annotation: Annotation;
  start: number;
  end: number;
}

/** Split one block's text into plain and highlighted segments. */
export function segmentBlock(
  text: string,
  hits: readonly ResolvedHit[],
): { text: string; annotation: Annotation | null }[] {
  if (hits.length === 0) return [{ text, annotation: null }];

  // Overlapping highlights would produce tangled spans; first one wins.
  const ordered = [...hits].sort((a, b) => a.start - b.start);
  const out: { text: string; annotation: Annotation | null }[] = [];
  let cursor = 0;
  for (const hit of ordered) {
    if (hit.start < cursor) continue;
    if (hit.start > cursor) out.push({ text: text.slice(cursor, hit.start), annotation: null });
    out.push({ text: text.slice(hit.start, hit.end), annotation: hit.annotation });
    cursor = hit.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), annotation: null });
  return out;
}

export function ArticleViewport({
  blocks,
  annotations,
  activeId,
  onActivate,
  onCreateHighlight,
  onMakeCard,
  onProgress,
  handleRef,
  onTimestampClick,
}: {
  blocks: ArticleBlock[];
  annotations: Annotation[];
  activeId: string | null;
  onActivate: (id: string | null) => void;
  onCreateHighlight: (anchor: TextAnchor, text: string, color: AnnotationColor) => void;
  onMakeCard: (text: string) => void;
  /** Reading percent 0-100 and the block currently at the top */
  onProgress: (percent: number, blockIndex: number) => void;
  handleRef?: React.RefObject<ArticleViewportHandle | null>;
  /** Recording readers can make their timestamp headings reopen the source. */
  onTimestampClick?: (timestamp: string) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const blockRefs = useRef<(HTMLElement | null)[]>([]);
  const [pending, setPending] = useState<{
    menuX: number;
    menuY: number;
    anchor: TextAnchor;
    text: string;
  } | null>(null);

  const texts = useMemo(() => blocks.map((b) => b.text), [blocks]);

  /** Resolve every text anchor against the current blocks, once per change. */
  const hitsByBlock = useMemo(() => {
    const map = new Map<number, ResolvedHit[]>();
    for (const annotation of annotations) {
      if (!isTextAnchored(annotation) || annotation.kind !== 'highlight') continue;
      const hit = findTextAnchor(texts, annotation.anchor);
      // A quote that no longer exists is dropped rather than mis-anchored
      if (!hit) continue;
      const list = map.get(hit.blockIndex) ?? [];
      list.push({ annotation, start: hit.start, end: hit.end });
      map.set(hit.blockIndex, list);
    }
    return map;
  }, [annotations, texts]);

  /** Stickies render as a margin note against their block. */
  const stickiesByBlock = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    for (const a of annotations) {
      if (!isTextAnchored(a) || a.kind !== 'sticky') continue;
      const list = map.get(a.anchor.blockIndex) ?? [];
      list.push(a);
      map.set(a.anchor.blockIndex, list);
    }
    return map;
  }, [annotations]);

  useImperativeHandle(handleRef, () => ({
    scrollToBlock: (blockIndex: number) => {
      blockRefs.current[blockIndex]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
  }));

  const report = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const scrollable = el.scrollHeight - el.clientHeight;
    const percent = scrollable <= 0 ? 100 : Math.round((el.scrollTop / scrollable) * 100);

    // The topmost block still intersecting the viewport is "where I am"
    const top = el.getBoundingClientRect().top;
    let current = 0;
    for (let i = 0; i < blockRefs.current.length; i++) {
      const node = blockRefs.current[i];
      if (!node) continue;
      if (node.getBoundingClientRect().bottom >= top) {
        current = i;
        break;
      }
    }
    onProgress(Math.max(0, Math.min(100, percent)), current);
  }, [onProgress]);

  useEffect(() => {
    report();
  }, [report, blocks]);

  /** Turn the live DOM selection into a block-relative text anchor. */
  const anchorFromSelection = useCallback((): { anchor: TextAnchor; text: string } | null => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);

    const host = (range.startContainer.parentElement as HTMLElement | null)?.closest(
      '[data-block-index]',
    );
    if (!host) return null;
    const blockIndex = Number(host.getAttribute('data-block-index'));
    if (!Number.isInteger(blockIndex)) return null;

    // Offset of the selection start within the block's full text
    const preceding = range.cloneRange();
    preceding.selectNodeContents(host);
    preceding.setEnd(range.startContainer, range.startOffset);
    const start = preceding.toString().length;
    const quote = range.toString();
    if (!quote.trim()) return null;

    const anchor = makeTextAnchor(texts, blockIndex, start, start + quote.length);
    return anchor ? { anchor, text: quote } : null;
  }, [texts]);

  const handlePointerUp = useCallback(() => {
    const picked = anchorFromSelection();
    if (!picked) {
      setPending(null);
      return;
    }
    const rects = window.getSelection()?.getRangeAt(0).getClientRects();
    const last = rects?.[rects.length - 1];
    if (!last) return;
    setPending({
      menuX: Math.min(Math.max(last.left + last.width / 2, 80), window.innerWidth - 80),
      menuY: Math.max(last.top - 10, 40),
      anchor: picked.anchor,
      text: picked.text,
    });
  }, [anchorFromSelection]);

  const clearSelection = () => {
    setPending(null);
    window.getSelection()?.removeAllRanges();
  };

  const highlight = (color: AnnotationColor) => {
    if (!pending) return;
    onCreateHighlight(pending.anchor, pending.text, color);
    clearSelection();
  };

  const makeCard = () => {
    if (!pending) return;
    onMakeCard(pending.text);
    clearSelection();
  };

  return (
    <div
      className="article-scroller"
      ref={scrollerRef}
      onScroll={report}
      onPointerUp={handlePointerUp}
    >
      {pending && (
        <SelectionMenu
          x={pending.menuX}
          y={pending.menuY}
          onPick={highlight}
          onMakeCard={makeCard}
        />
      )}
      <article className="article-body">
        {blocks.map((block, i) => (
          <div
            key={i}
            data-block-index={i}
            // Semantics come from role/aria; a computed tag name explodes into
            // a union TypeScript refuses to represent.
            role={block.kind === 'heading' ? 'heading' : undefined}
            aria-level={block.kind === 'heading' ? Math.min(6, Math.max(2, block.level)) : undefined}
            className={`article-block article-${block.kind}`}
            ref={(node) => {
              blockRefs.current[i] = node;
            }}
          >
            {onTimestampClick && block.kind === 'heading' && /^\d{1,2}:\d{2}(?::\d{2})?$/.test(block.text) ? (
              <button
                className="article-timestamp"
                title={`Open source at ${block.text}`}
                onClick={() => onTimestampClick(block.text)}
              >
                {block.text}
              </button>
            ) : hasRichSyntax(block.text) && (hitsByBlock.get(i) ?? []).length === 0 ? (
              <div className="article-rich-text"><Markdown text={block.text} /></div>
            ) : segmentBlock(block.text, hitsByBlock.get(i) ?? []).map((segment, s) =>
              segment.annotation ? (
                <mark
                  key={s}
                  className={
                    segment.annotation.id === activeId
                      ? 'article-mark active'
                      : segment.annotation.note
                        ? 'article-mark has-note'
                        : 'article-mark'
                  }
                  style={{ background: ANNOTATION_COLORS[segment.annotation.color] }}
                  title={segment.annotation.note || undefined}
                  onClick={() => onActivate(segment.annotation!.id)}
                >
                  {segment.text}
                </mark>
              ) : (
                <span key={s}>{segment.text}</span>
              ),
            )}
            {(stickiesByBlock.get(i) ?? []).map((sticky) => (
              <button
                key={sticky.id}
                className="article-sticky"
                title={sticky.note || 'Sticky note'}
                onClick={() => onActivate(sticky.id)}
              >
                note
              </button>
            ))}
          </div>
        ))}
      </article>
    </div>
  );
}
