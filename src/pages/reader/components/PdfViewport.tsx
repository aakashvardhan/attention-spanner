import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
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
import type { AnnotationColor, AnnotationRect, PdfAnchoredAnnotation } from '../../../shared/types';
import type { PdfPageSize } from '../usePdfDocument';
import { citationHref, resolveCitation, type Reference, type ReferenceIndex } from '../references';
import { knownTargetFor, type KnownTarget } from '../citationLinks';
import { MENTION_RE, mentionKey, type FigureKey } from '../figures';
import { AnnotationLayer } from './AnnotationLayer';
import { SelectionMenu } from './SelectionMenu';
import { CitationTooltip } from './CitationTooltip';
import { ZOOM_MAX, ZOOM_MIN } from './ReaderToolbar';

/** Vertical gap between pages, and padding above the first / below the last. */
const PAGE_GAP = 16;
/** Pages within this margin of the viewport get (and keep) a rendered canvas. */
const RENDER_MARGIN = '1500px 0px';
/** Side breathing room around the widest page at fit-width (zoom 1). */
const PAGE_INSET = 48;
/** Canvases re-render this long after the last zoom step; CSS stretches the old bitmap until then. */
const RERENDER_DELAY_MS = 150;

/** Navigation glides; restore and zoom re-anchoring never do. */
function navBehavior(): ScrollBehavior {
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
}

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
function wrapCitations(
  container: HTMLElement,
  index: ReferenceIndex,
  known: Map<string, KnownTarget>,
): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);

  for (const textNode of textNodes) {
    // Skip nodes already inside a marker (guards against a second wrapping pass).
    if (textNode.parentElement?.classList.contains('cite-marker')) continue;
    const text = textNode.nodeValue ?? '';
    if (text.length < 3) continue;
    const resolved = findMarkers(text)
      .map((m) => ({ ...m, refs: resolveCitation(index, m.data) }))
      .filter((m) => m.refs.length > 0);
    if (!resolved.length) continue;
    const markers = resolved;

    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const marker of markers) {
      if (marker.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, marker.start)));
      const span = document.createElement('span');
      span.className = 'cite-marker';
      if (marker.data.labels) span.dataset.labels = marker.data.labels.join(',');
      if (marker.data.author) span.dataset.author = marker.data.author;
      if (marker.data.year !== undefined) span.dataset.year = String(marker.data.year);
      // A citation you already have reads differently from one you don't —
      // Wikipedia's blue link. One attribute; the styling is in reader.css.
      if (marker.refs.some((r) => knownTargetFor(r, known))) span.dataset.known = 'true';
      span.textContent = text.slice(marker.start, marker.end);
      frag.appendChild(span);
      pos = marker.end;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

/**
 * Wrap figure/table mentions whose caption was found in
 * `<span class="fig-ref">`, the same in-place split wrapCitations does.
 */
function wrapFigureRefs(container: HTMLElement, figures: Map<FigureKey, PdfPosition>): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);

  for (const textNode of textNodes) {
    if (textNode.parentElement?.closest('.fig-ref, .cite-marker')) continue;
    const text = textNode.nodeValue ?? '';
    const hits = [...text.matchAll(MENTION_RE)].filter((m) => figures.has(mentionKey(m[1], m[2])));
    if (!hits.length) continue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const m of hits) {
      if (m.index > pos) frag.appendChild(document.createTextNode(text.slice(pos, m.index)));
      const span = document.createElement('span');
      span.className = 'fig-ref';
      span.dataset.figure = mentionKey(m[1], m[2]);
      span.textContent = m[0];
      frag.appendChild(span);
      pos = m.index + m[0].length;
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
  onZoom,
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
  known,
  figures,
}: {
  doc: PDFDocumentProxy;
  pageSizes: PdfPageSize[];
  /** Multiplier over fit-width; 1 = the page fills the viewport width */
  zoom: number;
  /** Pinch / ⌘-scroll zoom; the viewport keeps the point under the cursor still. */
  onZoom: (zoom: number) => void;
  /** Saved position to scroll to once layout is known; null starts at page 1 */
  initialPosition: PdfPosition | null;
  /** Fires once, after the initial scroll (or immediately when there is none) */
  onRestored: () => void;
  onPosition: (pos: PdfPosition) => void;
  handleRef: Ref<PdfViewportHandle>;
  /** All annotations for the current document */
  annotations: PdfAnchoredAnnotation[];
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
  /** Citations that resolve to something the reader already has, by match key. */
  known: Map<string, KnownTarget>;
  /** Where each figure/table caption sits; null until scanned. */
  figures: Map<FigureKey, PdfPosition> | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current!;
    setContainerWidth(el.clientWidth);
    // Arrow keys and Space scroll the document from the first moment, as in Preview.
    // That load-time focus is not a selection, so it draws no ring; the first
    // time focus leaves, the marker goes and keyboard focus shows normally.
    el.dataset.autofocused = '';
    el.addEventListener('blur', () => delete el.dataset.autofocused, { once: true });
    el.focus({ preventScroll: true });
    const observer = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fit-width baseline: the widest page spans the container minus breathing room.
  const maxPageWidth = useMemo(
    () => Math.max(...pageSizes.map((s) => s.width), 1),
    [pageSizes],
  );
  const scale = containerWidth > 0 ? ((containerWidth - PAGE_INSET) / maxPageWidth) * zoom : 0;
  // Wider than the viewport once zoomed in, so the whole page can be scrolled
  // to; centered pages in a fixed-width list put their left side out of reach.
  const listWidth = Math.max(containerWidth, maxPageWidth * scale + PAGE_INSET);

  // Canvases and text layers render at a scale that trails the live one, so a
  // pinch stretches what is already painted instead of re-rasterizing per frame.
  const [renderScale, setRenderScale] = useState(0);
  useEffect(() => {
    if (renderScale === 0) {
      setRenderScale(scale);
      return;
    }
    const timer = window.setTimeout(() => setRenderScale(scale), RERENDER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [scale, renderScale]);

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

  /** anchorY: where in the viewport the position lands; the middle by default. */
  const scrollToPosition = useCallback(
    (page: number, offset: number, behavior: ScrollBehavior = 'instant', anchorY?: number) => {
      const el = containerRef.current;
      if (!el || tops.length === 0) return;
      const index = Math.min(tops.length, Math.max(1, page)) - 1;
      const target = Math.max(0, tops[index] + offset * heights[index] - (anchorY ?? el.clientHeight / 2));
      // Chrome's glide lengthens with distance (~1.4s across a paper). Cut to
      // one screen short and glide the rest: quick, and still shows direction.
      const distance = target - el.scrollTop;
      if (behavior === 'smooth' && Math.abs(distance) > el.clientHeight) {
        el.scrollTop = target - Math.sign(distance) * el.clientHeight;
      }
      el.scrollTo({ top: target, behavior });
      lastPosRef.current = { page: index + 1, offset };
    },
    [tops, heights],
  );

  // A page jump (offset 0) puts the page's top at the top, as Preview does; a
  // spot inside a page (an annotation) lands in the middle.
  useImperativeHandle(
    handleRef,
    () => ({
      scrollToPosition: (page, offset) =>
        scrollToPosition(page, offset, navBehavior(), offset === 0 ? PAGE_GAP : undefined),
    }),
    [scrollToPosition],
  );

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

  // Zoom keeps the reading position: re-anchor the scroll after a scale change,
  // before paint so a pinch never shows a frame at the wrong spot. A pinch
  // anchors on the point under the cursor; the toolbar on the middle.
  const zoomAnchorRef = useRef<{ x: number; y: number; page: number; offset: number; fromCenter: number } | null>(null);
  const prevScaleRef = useRef(0);
  useLayoutEffect(() => {
    if (scale > 0 && prevScaleRef.current > 0 && prevScaleRef.current !== scale) {
      const anchor = zoomAnchorRef.current;
      zoomAnchorRef.current = null;
      if (anchor) {
        scrollToPosition(anchor.page, anchor.offset, 'instant', anchor.y);
        containerRef.current!.scrollLeft = listWidth / 2 + anchor.fromCenter * scale - anchor.x;
      } else {
        const { page, offset } = lastPosRef.current;
        scrollToPosition(page, offset);
      }
    }
    prevScaleRef.current = scale;
  }, [scale, listWidth, scrollToPosition]);

  // Trackpad pinch arrives as ctrl+wheel; ⌘+wheel is the mouse equivalent.
  // Native listener: React's onWheel is passive and can't stop browser zoom.
  const live = useRef({ zoom, scale, tops, heights, listWidth, onZoom });
  live.current = { zoom, scale, tops, heights, listWidth, onZoom };
  useEffect(() => {
    const el = containerRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const l = live.current;
      if (l.scale <= 0) return;
      const step = Math.max(-25, Math.min(25, e.deltaY));
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, l.zoom * Math.exp(-step * 0.01)));
      if (next === l.zoom) return;
      const box = el.getBoundingClientRect();
      const x = e.clientX - box.left;
      const y = e.clientY - box.top;
      const pos = positionFromScroll(l.tops, l.heights, el.scrollTop + y);
      zoomAnchorRef.current = { x, y, ...pos, fromCenter: (el.scrollLeft + x - l.listWidth / 2) / l.scale };
      l.zoom = next;
      l.onZoom(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

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
    // Open toward the side with more room; the tooltip caps its height to it.
    const flip = rect.top < window.innerHeight / 2;
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

  // Where a figure jump left from; the Back button returns there. Chained jumps
  // keep the first spot, the one the reader was actually reading.
  const [backTo, setBackTo] = useState<PdfPosition | null>(null);

  // Clicking a citation opens its reference; a figure mention jumps to its
  // caption. Skip when the click is part of a text selection so selecting
  // across a marker doesn't navigate.
  const handleCitationClick = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    const figRef = (e.target as HTMLElement).closest<HTMLElement>('.fig-ref');
    const target = figRef && figures?.get(figRef.dataset.figure ?? '');
    if (target) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      // Read now: the updater runs at render, after the jump has moved the ref.
      const here = lastPosRef.current;
      setBackTo((b) => b ?? here);
      scrollToPosition(target.page, target.offset, navBehavior());
      return;
    }
    if (!references) return;
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
    const map = new Map<number, PdfAnchoredAnnotation[]>();
    for (const a of annotations) {
      const list = map.get(a.anchor.page) ?? [];
      list.push(a);
      map.set(a.anchor.page, list);
    }
    return map;
  }, [annotations]);

  return (
    <>
      <div
        className="reader-viewport"
        ref={containerRef}
        role="region"
        aria-label="PDF document"
        tabIndex={0}
        onScroll={handleScroll}
        onPointerUp={handlePointerUp}
        onMouseOver={handleCitationOver}
        onMouseOut={handleCitationOut}
        onClick={handleCitationClick}
      >
        <div className="reader-page-list" style={{ height: totalHeight, width: listWidth }}>
          {scale > 0 &&
            pageSizes.map((size, i) => {
              const page = i + 1;
              return (
                <div
                  key={i}
                  ref={registerPage(page)}
                  data-page={page}
                  className="reader-page"
                  role="group"
                  aria-label={`Page ${page} of ${pageSizes.length}`}
                  style={{
                    top: tops[i],
                    width: size.width * scale,
                    height: heights[i],
                    ['--scale-factor' as string]: String(scale),
                  }}
                >
                  {visiblePages.has(page) && renderScale > 0 && (
                    <>
                      <PageCanvas doc={doc} pageNumber={page} scale={renderScale} />
                      <PageTextLayer
                        doc={doc}
                        pageNumber={page}
                        scale={renderScale}
                        references={references}
                        known={known}
                        figures={figures}
                      />
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
      {backTo && (
        <button
          type="button"
          className="reader-back-btn"
          onClick={() => {
            scrollToPosition(backTo.page, backTo.offset, navBehavior());
            setBackTo(null);
          }}
        >
          ← Back to reading
        </button>
      )}
      {pendingSelection && (
        <SelectionMenu
          x={pendingSelection.menuX}
          y={pendingSelection.menuY}
          onPick={handlePickColor}
        />
      )}
      {citationHover && (
        <CitationTooltip
          refs={citationHover.refs}
          known={known}
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
      if (cancelled) return;
      // Cap the backing resolution — full dpr×zoom canvases are megabytes each.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: scale * dpr });
      // Paint off-screen and swap in when done: resizing the visible canvas
      // clears it, which flashed every page white on each zoom step.
      const offscreen = document.createElement('canvas');
      offscreen.width = Math.floor(viewport.width);
      offscreen.height = Math.floor(viewport.height);
      renderTask = page.render({ canvas: offscreen, canvasContext: offscreen.getContext('2d')!, viewport });
      try {
        await renderTask.promise;
      } catch {
        return; // Cancellation rejects the promise; that's the expected teardown path.
      }
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      canvas.width = offscreen.width;
      canvas.height = offscreen.height;
      canvas.getContext('2d')!.drawImage(offscreen, 0, 0);
      canvas.dataset.ready = 'true';
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
  known,
  figures,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  references: ReferenceIndex | null;
  known: Map<string, KnownTarget>;
  figures: Map<FigureKey, PdfPosition> | null;
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
    wrapCitations(container, references, known);
  }, [references, renderGen, known]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !figures?.size || renderGen === 0) return;
    wrapFigureRefs(container, figures);
  }, [figures, renderGen]);

  return <div ref={containerRef} className="textLayer" />;
}
