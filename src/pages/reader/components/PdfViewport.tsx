import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from 'react';
import { TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import { ANNOTATION_TEXT_MAX_CHARS } from '../../../shared/constants';
import { mergeLineRects, normalizeRects } from '../../../shared/annotations';
import { positionFromScroll, type PdfPosition } from '../../../shared/pdf';
import type { AnnotationColor, AnnotationRect, PdfAnnotation } from '../../../shared/types';
import type { PdfPageSize } from '../usePdfDocument';
import { citationHref, resolveCitation, type Reference, type ReferenceIndex } from '../references';
import { AnnotationLayer } from './AnnotationLayer';
import { SelectionMenu } from './SelectionMenu';
import { CitationTooltip } from './CitationTooltip';

/** Vertical gap between pages, and padding above the first / below the last. */
const PAGE_GAP = 16;
/** Pages within this margin of the viewport get (and keep) a rendered canvas. */
const RENDER_MARGIN = '1500px 0px';

export interface PdfViewportHandle {
  scrollToPosition(page: number, offset: number): void;
}

interface PendingSelection {
  menuX: number;
  menuY: number;
  text: string;
  byPage: Map<number, AnnotationRect[]>;
}

interface CitationHover {
  refs: Reference[];
  x: number;
  y: number;
  /** Place below the marker instead of above (marker near the viewport top). */
  flip: boolean;
}

/** What a matched marker resolves against; mirrors resolveCitation's argument. */
interface MarkerData {
  labels?: string[];
  author?: string;
  year?: number;
}

/** Expand a bracket group's inner text ("3, 4", "5-7") into individual labels. */
function expandLabels(inner: string): string[] {
  const out: string[] = [];
  for (const token of inner.split(',')) {
    const range = token.trim().match(/^(\d{1,3})\s*[–-]\s*(\d{1,3})$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (b >= a && b - a < 100) for (let n = a; n <= b; n++) out.push(String(n));
    } else if (/^\d{1,3}$/.test(token.trim())) {
      out.push(token.trim());
    }
  }
  return out;
}

/** Find citation markers in a run of text: numeric [n] and author-year forms. */
function findMarkers(text: string): { start: number; end: number; data: MarkerData }[] {
  const found: { start: number; end: number; data: MarkerData }[] = [];
  for (const m of text.matchAll(/\[(\d{1,3}(?:\s*[,–-]\s*\d{1,3})*)\]/g)) {
    found.push({ start: m.index, end: m.index + m[0].length, data: { labels: expandLabels(m[1]) } });
  }
  // Parenthetical: (Vaswani et al., 2017), (Devlin & Chang, 2019), (Smith, 2020).
  for (const m of text.matchAll(/\(([A-Z][A-Za-z'’-]+)[^)]*?\b(19|20)(\d{2})[a-z]?\)/g)) {
    found.push({
      start: m.index,
      end: m.index + m[0].length,
      data: { author: m[1], year: Number(`${m[2]}${m[3]}`) },
    });
  }
  // Narrative: Vaswani et al. (2017), Devlin and Chang (2019), Smith (2020).
  for (const m of text.matchAll(
    /\b([A-Z][A-Za-z'’-]+)(?:\s+et al\.?)?(?:\s*(?:and|&)\s*[A-Z][A-Za-z'’-]+)?\s*\((19|20)(\d{2})[a-z]?\)/g,
  )) {
    found.push({
      start: m.index,
      end: m.index + m[0].length,
      data: { author: m[1], year: Number(`${m[2]}${m[3]}`) },
    });
  }
  // Sort by position and drop overlaps (keep the earlier match).
  found.sort((a, b) => a.start - b.start);
  const result: typeof found = [];
  let lastEnd = -1;
  for (const f of found) {
    if (f.start >= lastEnd) {
      result.push(f);
      lastEnd = f.end;
    }
  }
  return result;
}

/**
 * Wrap resolvable citation markers in the rendered text layer with
 * `<span class="cite-marker">` so they become hover targets. Splits text nodes
 * in place — the characters are unchanged, so native selection/copy still work
 * (the same guarantee the transparent-glyph overlay already relies on).
 */
function wrapCitations(container: HTMLElement, index: ReferenceIndex): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);

  for (const textNode of textNodes) {
    // Skip nodes already inside a marker (guards against a second wrapping pass).
    if (textNode.parentElement?.classList.contains('cite-marker')) continue;
    const text = textNode.nodeValue ?? '';
    if (text.length < 3) continue;
    const markers = findMarkers(text).filter((m) => resolveCitation(index, m.data).length > 0);
    if (!markers.length) continue;

    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const marker of markers) {
      if (marker.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, marker.start)));
      const span = document.createElement('span');
      span.className = 'cite-marker';
      if (marker.data.labels) span.dataset.labels = marker.data.labels.join(',');
      if (marker.data.author) span.dataset.author = marker.data.author;
      if (marker.data.year !== undefined) span.dataset.year = String(marker.data.year);
      span.textContent = text.slice(marker.start, marker.end);
      frag.appendChild(span);
      pos = marker.end;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

/**
 * The scrolling page list. Every page gets a fixed-size placeholder up front
 * (sizes are known before any rendering), so scroll geometry is exact; an
 * IntersectionObserver fills in canvases near the viewport and drops far-away
 * ones to bound memory. No virtualization library — papers are 10–30 pages.
 */
export function PdfViewport({
  doc,
  pageSizes,
  zoom,
  initialPosition,
  onRestored,
  onPosition,
  handleRef,
  annotations,
  activeId,
  onActivate,
  noteMode,
  onCreateHighlight,
  onPlaceSticky,
  onUpdateNote,
  onUpdateColor,
  onDeleteAnnotation,
  references,
}: {
  doc: PDFDocumentProxy;
  pageSizes: PdfPageSize[];
  /** Multiplier over fit-width; 1 = the page fills the viewport width */
  zoom: number;
  /** Saved position to scroll to once layout is known; null starts at page 1 */
  initialPosition: PdfPosition | null;
  /** Fires once, after the initial scroll (or immediately when there is none) */
  onRestored: () => void;
  onPosition: (pos: PdfPosition) => void;
  handleRef: Ref<PdfViewportHandle>;
  /** All annotations for the current document */
  annotations: PdfAnnotation[];
  activeId: string | null;
  onActivate: (id: string | null) => void;
  noteMode: boolean;
  onCreateHighlight: (page: number, rects: AnnotationRect[], text: string, color: AnnotationColor) => void;
  onPlaceSticky: (page: number, x: number, y: number) => void;
  onUpdateNote: (id: string, note: string) => void;
  onUpdateColor: (id: string, color: AnnotationColor) => void;
  onDeleteAnnotation: (id: string) => void;
  /** Bibliography index for citation hover previews; null until extracted. */
  references: ReferenceIndex | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current!;
    setContainerWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fit-width baseline: the widest page spans the container minus breathing room.
  const maxPageWidth = useMemo(
    () => Math.max(...pageSizes.map((s) => s.width), 1),
    [pageSizes],
  );
  const scale = containerWidth > 0 ? ((containerWidth - 48) / maxPageWidth) * zoom : 0;

  const { tops, heights, totalHeight } = useMemo(() => {
    const tops: number[] = [];
    const heights: number[] = [];
    let y = PAGE_GAP;
    for (const size of pageSizes) {
      tops.push(y);
      heights.push(size.height * scale);
      y += size.height * scale + PAGE_GAP;
    }
    return { tops, heights, totalHeight: y };
  }, [pageSizes, scale]);

  const lastPosRef = useRef<PdfPosition>({ page: 1, offset: 0 });

  const scrollToPosition = useCallback(
    (page: number, offset: number) => {
      const el = containerRef.current;
      if (!el || tops.length === 0) return;
      const index = Math.min(tops.length, Math.max(1, page)) - 1;
      const target = tops[index] + offset * heights[index] - el.clientHeight / 2;
      el.scrollTop = Math.max(0, target);
      lastPosRef.current = { page: index + 1, offset };
    },
    [tops, heights],
  );

  useImperativeHandle(handleRef, () => ({ scrollToPosition }), [scrollToPosition]);

  // The saved position can only be applied once real layout exists (scale > 0,
  // i.e. the container has been measured) — so the restore lives here, not in
  // the parent, and runs exactly once.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (scale <= 0 || restoredRef.current) return;
    restoredRef.current = true;
    if (initialPosition) scrollToPosition(initialPosition.page, initialPosition.offset);
    onRestored();
  }, [scale, initialPosition, scrollToPosition, onRestored]);

  // Zoom keeps the reading position: re-anchor the scroll after a scale change.
  const prevScaleRef = useRef(0);
  useEffect(() => {
    if (scale > 0 && prevScaleRef.current > 0 && prevScaleRef.current !== scale) {
      const { page, offset } = lastPosRef.current;
      scrollToPosition(page, offset);
    }
    prevScaleRef.current = scale;
  }, [scale, scrollToPosition]);

  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);

  // Citation hover preview. A short close grace lets the pointer travel from the
  // marker into the tooltip (to click the link) without it vanishing.
  const [citationHover, setCitationHover] = useState<CitationHover | null>(null);
  const hoverCloseRef = useRef(0);
  const cancelHoverClose = () => clearTimeout(hoverCloseRef.current);
  const scheduleHoverClose = () => {
    cancelHoverClose();
    hoverCloseRef.current = window.setTimeout(() => setCitationHover(null), 300);
  };
  useEffect(() => () => clearTimeout(hoverCloseRef.current), []);

  const handleCitationOver = (e: ReactMouseEvent) => {
    if (!references) return;
    const marker = (e.target as HTMLElement).closest<HTMLElement>('.cite-marker');
    if (!marker) return;
    const refs = resolveCitation(references, {
      labels: marker.dataset.labels ? marker.dataset.labels.split(',') : undefined,
      author: marker.dataset.author,
      year: marker.dataset.year ? Number(marker.dataset.year) : undefined,
    });
    if (!refs.length) return;
    cancelHoverClose();
    const rect = marker.getBoundingClientRect();
    const flip = rect.top < 200;
    setCitationHover({
      refs,
      x: Math.min(Math.max(rect.left + rect.width / 2, 184), window.innerWidth - 184),
      y: flip ? rect.bottom + 6 : rect.top - 6,
      flip,
    });
  };

  const handleCitationOut = (e: ReactMouseEvent) => {
    if (!(e.target as HTMLElement).closest('.cite-marker')) return;
    const related = e.relatedTarget as HTMLElement | null;
    if (related?.closest?.('.cite-tooltip')) return;
    scheduleHoverClose();
  };

  // Clicking a citation opens its reference. Skip when the click is part of a
  // text selection so selecting across a marker doesn't navigate.
  const handleCitationClick = (e: ReactMouseEvent) => {
    if (!references || e.button !== 0) return;
    const marker = (e.target as HTMLElement).closest<HTMLElement>('.cite-marker');
    if (!marker) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const refs = resolveCitation(references, {
      labels: marker.dataset.labels ? marker.dataset.labels.split(',') : undefined,
      author: marker.dataset.author,
      year: marker.dataset.year ? Number(marker.dataset.year) : undefined,
    });
    if (!refs.length) return;
    window.open(citationHref(refs[0]), '_blank', 'noopener,noreferrer');
  };

  const rafRef = useRef(0);
  const handleScroll = () => {
    setPendingSelection(null);
    setCitationHover(null);
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const el = containerRef.current;
      if (!el || tops.length === 0) return;
      const pos = positionFromScroll(tops, heights, el.scrollTop + el.clientHeight / 2);
      lastPosRef.current = pos;
      onPosition(pos);
    });
  };

  // One observer for all pages; callback refs register/unregister against it.
  const [visiblePages, setVisiblePages] = useState<ReadonlySet<number>>(new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const pageEls = useRef(new Map<number, HTMLDivElement>());

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const page = Number((entry.target as HTMLElement).dataset.page);
            if (entry.isIntersecting) next.add(page);
            else next.delete(page);
          }
          return next;
        });
      },
      { root: containerRef.current, rootMargin: RENDER_MARGIN },
    );
    observerRef.current = observer;
    for (const el of pageEls.current.values()) observer.observe(el);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, []);

  const registerPage = (page: number) => (el: HTMLDivElement | null) => {
    const prev = pageEls.current.get(page);
    if (prev) observerRef.current?.unobserve(prev);
    if (el) {
      pageEls.current.set(page, el);
      observerRef.current?.observe(el);
    } else {
      pageEls.current.delete(page);
    }
  };

  // Text selection → a pending highlight, offered via the floating SelectionMenu.
  // A selection can span pages (getClientRects returns rects across the gap);
  // each rect is assigned to the page whose box contains its center, so one
  // highlight annotation is created per page.
  const handlePointerUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
    if (!anchor || !containerRef.current?.contains(anchor)) return;

    const range = sel.getRangeAt(0);
    const clientRects = Array.from(range.getClientRects());
    if (clientRects.length === 0) return;

    const rawByPage = new Map<number, DOMRect[]>();
    for (const rect of clientRects) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      for (const [page, el] of pageEls.current) {
        const box = el.getBoundingClientRect();
        if (cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom) {
          const list = rawByPage.get(page) ?? [];
          list.push(rect);
          rawByPage.set(page, list);
          break;
        }
      }
    }
    if (rawByPage.size === 0) return;

    const byPage = new Map<number, AnnotationRect[]>();
    for (const [page, rects] of rawByPage) {
      const box = pageEls.current.get(page)!.getBoundingClientRect();
      const merged = mergeLineRects(normalizeRects(rects, box));
      if (merged.length) byPage.set(page, merged);
    }
    if (byPage.size === 0) return;

    const last = clientRects[clientRects.length - 1];
    setPendingSelection({
      menuX: Math.min(Math.max(last.left + last.width / 2, 80), window.innerWidth - 80),
      menuY: Math.max(last.top - 10, 40),
      text: sel.toString().replace(/\s+/g, ' ').trim().slice(0, ANNOTATION_TEXT_MAX_CHARS),
      byPage,
    });
  };

  const handlePickColor = (color: AnnotationColor) => {
    if (!pendingSelection) return;
    for (const [page, rects] of pendingSelection.byPage) {
      onCreateHighlight(page, rects, pendingSelection.text, color);
    }
    window.getSelection()?.removeAllRanges();
    setPendingSelection(null);
  };

  useEffect(() => {
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setPendingSelection(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPendingSelection(null);
        setCitationHover(null);
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // Clicking anywhere that isn't an annotation, its popover, or the selection
  // menu closes the active note popover.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.annot-popover, .annot-highlight, .annot-pin, .annot-selection-menu')) return;
      onActivate(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onActivate]);

  const annotationsByPage = useMemo(() => {
    const map = new Map<number, PdfAnnotation[]>();
    for (const a of annotations) {
      const list = map.get(a.page) ?? [];
      list.push(a);
      map.set(a.page, list);
    }
    return map;
  }, [annotations]);

  return (
    <>
      <div
        className="reader-viewport"
        ref={containerRef}
        onScroll={handleScroll}
        onPointerUp={handlePointerUp}
        onMouseOver={handleCitationOver}
        onMouseOut={handleCitationOut}
        onClick={handleCitationClick}
      >
        <div className="reader-page-list" style={{ height: totalHeight }}>
          {scale > 0 &&
            pageSizes.map((size, i) => {
              const page = i + 1;
              return (
                <div
                  key={i}
                  ref={registerPage(page)}
                  data-page={page}
                  className="reader-page"
                  style={{
                    top: tops[i],
                    width: size.width * scale,
                    height: heights[i],
                    ['--scale-factor' as string]: String(scale),
                  }}
                >
                  {visiblePages.has(page) && (
                    <>
                      <PageCanvas doc={doc} pageNumber={page} scale={scale} />
                      <PageTextLayer doc={doc} pageNumber={page} scale={scale} references={references} />
                      <AnnotationLayer
                        annotations={annotationsByPage.get(page) ?? []}
                        activeId={activeId}
                        onActivate={onActivate}
                        noteMode={noteMode}
                        onPlaceSticky={(x, y) => onPlaceSticky(page, x, y)}
                        onUpdateNote={onUpdateNote}
                        onUpdateColor={onUpdateColor}
                        onDelete={onDeleteAnnotation}
                      />
                    </>
                  )}
                </div>
              );
            })}
        </div>
      </div>
      {pendingSelection && (
        <SelectionMenu x={pendingSelection.menuX} y={pendingSelection.menuY} onPick={handlePickColor} />
      )}
      {citationHover && (
        <CitationTooltip
          refs={citationHover.refs}
          x={citationHover.x}
          y={citationHover.y}
          flip={citationHover.flip}
          onEnter={cancelHoverClose}
          onLeave={scheduleHoverClose}
        />
      )}
    </>
  );
}

function PageCanvas({
  doc,
  pageNumber,
  scale,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    void (async () => {
      const page = await doc.getPage(pageNumber);
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      // Cap the backing resolution — full dpr×zoom canvases are megabytes each.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: scale * dpr });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      renderTask = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport });
      // Cancellation rejects the promise; that's the expected teardown path.
      await renderTask.promise.catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, pageNumber, scale]);

  return <canvas ref={canvasRef} className="reader-canvas" />;
}

/**
 * The invisible selectable-text overlay. Sized purely from CSS vars pdf.js's
 * TextLayer sets on the container (--scale-factor comes from the page div;
 * see reader.css); the viewport passed here uses the CSS scale (not × dpr —
 * that's a canvas-only concern for backing-store resolution).
 */
function PageTextLayer({
  doc,
  pageNumber,
  scale,
  references,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  references: ReferenceIndex | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Bumps once the text layer has finished rendering, so the citation-wrapping
  // effect below runs against real spans (and re-runs after a scale re-render).
  const [renderGen, setRenderGen] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let layer: TextLayer | null = null;
    void (async () => {
      const page = await doc.getPage(pageNumber);
      const container = containerRef.current;
      if (cancelled || !container) return;
      // StrictMode double-mounts this effect; clear any leftover spans first.
      container.replaceChildren();
      layer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container,
        viewport: page.getViewport({ scale }),
      });
      // Cancellation rejects the promise; that's the expected teardown path.
      await layer.render().catch(() => undefined);
      if (!cancelled) setRenderGen((g) => g + 1);
    })();
    return () => {
      cancelled = true;
      layer?.cancel();
    };
  }, [doc, pageNumber, scale]);

  // Wrap citation markers once the layer has rendered and references exist. A
  // scale change re-renders the layer (clearing wrappers), which bumps renderGen
  // and re-wraps at the new scale.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !references || references.isEmpty || renderGen === 0) return;
    wrapCitations(container, references);
  }, [references, renderGen]);

  return <div ref={containerRef} className="textLayer" />;
}
