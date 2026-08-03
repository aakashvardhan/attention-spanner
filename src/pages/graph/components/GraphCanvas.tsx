import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ALPHA_REST, type LayoutNode, type LayoutState } from '../../../shared/graphLayout';
import type { GraphModel, RenderNode } from '../../../shared/graphModel';
import { radiusFor, useGraphLayout } from '../useGraphLayout';
import '../../../shared/components/graphCanvas.css';

const KIND_LABEL: Record<RenderNode['kind'], string> = {
  article: 'Article',
  video: 'Video',
  paper: 'Paper',
  bookmark: 'Bookmark',
  recording: 'Recording',
  external: 'Cited paper',
  note: 'Note',
  highlight: 'Highlight',
};

/**
 * Every node asks for a label. An unlabelled dot tells you nothing and costs a
 * hover to identify, which is the whole reason a graph of forty things reads as
 * noise; the collision pass below still drops the ones that cannot fit, so the
 * page stays legible without being anonymous.
 */
const LABEL_MIN_DEGREE = 0;
/** Clearance around a placed label before it counts as colliding. */
const LABEL_GUTTER = 3;
/** Space kept between the outermost node and the window edge. */
const FIT_MARGIN = 48;
/** Ceiling on filling the page — beyond this a sparse graph looks blown up. */
const MAX_FIT_SCALE = 1.8;
/**
 * How far the user may zoom by hand. Wider than the fit range on both ends: the
 * fit only ever answers "show me everything", and the two questions this is
 * actually for — read the titles in one dense cluster, see the whole shape of a
 * library that does not fit — live outside it.
 */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
/** Wheel notch → zoom factor. Gentle enough that a trackpad flick is steerable. */
const ZOOM_PER_PIXEL = 0.0015;
/** What the +/- buttons step by. */
const ZOOM_STEP = 1.3;
/** Strip along the bottom the lineage time axis draws into. */
const AXIS_HEIGHT = 30;
/** Room a label needs beside its node, where labels are always drawn. */
const LABEL_FIT_MARGIN = 110;

/** Arrowhead size, in device-independent pixels. */
const HEAD_LENGTH = 9;
const HEAD_WIDTH = 5;

/** Stable identity for the default prop, so it never re-triggers a memo. */
const EMPTY_SET: ReadonlySet<string> = new Set();

export type ConnectionMode = 'evidence' | 'organization' | 'discover';

const MODE_REASONS: Record<ConnectionMode, ReadonlySet<string>> = {
  evidence: new Set(['link']),
  organization: new Set(['deck', 'group', 'video', 'annotation']),
  discover: new Set(['tag', 'domain']),
};

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the graph sits on screen: `screen = graph * k + t`.
 *
 * One transform for everything — edges, arrowheads, node transforms, label
 * collision and pointer maths all read it, so there is no second place for a
 * zoom to be forgotten. `k` also scales the drawn node radii (see the
 * `--gr-zoom` custom property): scaling the distances but not the discs is what
 * turned a large library into a pile of overlapping circles.
 */
interface View {
  k: number;
  tx: number;
  ty: number;
}

/** Chrome floating over the canvas that the fit must not place content under. */
export interface Insets {
  right: number;
  bottom: number;
  left: number;
}

const NO_INSETS: Insets = { right: 0, bottom: 0, left: 0 };

function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

/**
 * One citation, drawn as a line with a head at the cited end.
 *
 * The head stops at the target's edge rather than its centre, or it lands
 * underneath the node and the direction is invisible on exactly the
 * well-connected papers where it matters most. The shaft stops short of the
 * head so the two do not overlap into a blob at small sizes.
 */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  targetRadius: number,
): void {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.hypot(dx, dy);
  // Two nodes on top of each other have no direction to draw.
  if (dist < targetRadius + HEAD_LENGTH) return;

  const ux = dx / dist;
  const uy = dy / dist;
  const tipX = toX - ux * targetRadius;
  const tipY = toY - uy * targetRadius;
  const baseX = tipX - ux * HEAD_LENGTH;
  const baseY = tipY - uy * HEAD_LENGTH;

  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(baseX, baseY);
  ctx.stroke();

  // Perpendicular, for the two back corners of the head.
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(baseX - uy * HEAD_WIDTH, baseY + ux * HEAD_WIDTH);
  ctx.lineTo(baseX + uy * HEAD_WIDTH, baseY - ux * HEAD_WIDTH);
  ctx.closePath();
  ctx.fill();
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x - LABEL_GUTTER < b.x + b.w &&
    a.x + a.w + LABEL_GUTTER > b.x &&
    a.y - LABEL_GUTTER < b.y + b.h &&
    a.y + a.h + LABEL_GUTTER > b.y
  );
}

/**
 * Decide which labels actually get drawn.
 *
 * Every label wants the same strip of space directly under its node, and in a
 * cluster the nodes are closer together than the labels are wide — so without
 * this, a deck of eight papers renders eight titles on top of each other.
 * Greedy, in priority order: the best-connected node claims its space first,
 * and anything that would land on an accepted label *or* on any node is
 * dropped rather than drawn illegibly. Hover and selection bypass all of it.
 */
function placeLabels(
  state: LayoutState,
  layer: HTMLElement,
  selected: string | null,
  k: number,
): void {
  const candidates: { el: HTMLElement; node: LayoutNode; degree: number; hit: boolean }[] = [];
  const nodeBoxes: Box[] = [];

  // Translation is uniform, so it cancels out of every overlap test — only the
  // zoom has to be applied here.
  for (let i = 0; i < state.nodes.length; i++) {
    const button = (layer.children[i] as HTMLElement | undefined)
      ?.firstElementChild as HTMLElement | null;
    if (!button) continue;
    const node = state.nodes[i];
    // Collision has to be tested where the nodes are *drawn*, not where the
    // simulation put them, or the view transform silently invalidates it. The
    // radius is scaled too, because the disc is.
    const r = node.r * k;
    nodeBoxes.push({
      x: node.x * k - r,
      y: node.y * k - r,
      w: r * 2,
      h: r * 2,
    });
    if (button.dataset.label !== 'always') continue;
    candidates.push({
      el: button,
      node,
      degree: Number(button.dataset.degree ?? 0),
      hit: button.dataset.hit === 'true',
    });
  }

  // One batched read after all the transform writes, so this costs a single
  // reflow rather than one per label.
  const sized = candidates.map((c) => {
    const rect = (c.el.firstElementChild as HTMLElement).getBoundingClientRect();
    return { ...c, w: rect.width, h: rect.height };
  });

  // Selection first, then search hits, then the best connected — the label most
  // worth reading gets the space when two of them want it. Search outranks
  // degree because a search is the user saying which label they want: dimming
  // everything else and then culling the one they asked for is the opposite of
  // finding something.
  sized.sort(
    (a, b) =>
      Number(b.node.id === selected) - Number(a.node.id === selected) ||
      Number(b.hit) - Number(a.hit) ||
      b.degree - a.degree,
  );

  const taken: Box[] = [];
  for (const c of sized) {
    const box = {
      x: c.node.x * k - c.w / 2,
      y: c.node.y * k + c.node.r * k + 4,
      w: c.w,
      h: c.h,
    };
    const collides = taken.some((t) => overlaps(box, t)) || nodeBoxes.some((n) => overlaps(box, n));
    c.el.dataset.labelHidden = collides ? 'true' : 'false';
    if (!collides) taken.push(box);
  }
}

interface Props {
  model: GraphModel;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onOpen: (node: RenderNode) => void;
  /** Search text — non-matching nodes dim rather than disappear */
  query: string;
  /** Layout targets, when the caller has its own (lineage mode) */
  homes?: Map<string, { x: number; y: number }> | null;
  /** Column labels for those targets — the axis lineage mode never drew */
  axis?: readonly { x: number; label: string }[] | null;
  /** Which non-citation relationship layer to draw. */
  connectionMode?: ConnectionMode;
  /** Ghost papers several of your own cite — drawn larger and always labelled */
  promoted?: ReadonlySet<string>;
  /** Chrome floating over the canvas, so the fit stops centring underneath it */
  insets?: Insets;
  /** How many nodes the query matched; null when there is no query */
  onMatchCount?: (count: number | null) => void;
  /**
   * Bumped by the page to mean "frame the matches now" — Enter in the search
   * box. Kept separate from the query itself so that typing dims and labels as
   * you go, but the map only jumps when you ask it to.
   */
  frameMatchesNonce?: number;
  /** Assistant focus: select and bring exactly this node into view. */
  focusId?: string;
  focusNonce?: number;
}

export function GraphCanvas({
  model,
  selected,
  onSelect,
  onOpen,
  query,
  homes = null,
  axis = null,
  connectionMode = 'evidence',
  promoted = EMPTY_SET,
  insets = NO_INSETS,
  onMatchCount,
  frameMatchesNonce = 0,
  focusId = '',
  focusNonce = 0,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLUListElement>(null);
  const colorsRef = useRef({
    edge: '#d0d0d0',
    region: '#909090',
    cite: '#525252',
    mention: '#8b7fd4',
  });
  const gestureRef = useRef<
    | { kind: 'node'; index: number; pointerId: number }
    | { kind: 'pan'; pointerId: number; lastX: number; lastY: number }
    | null
  >(null);
  /** The live transform; pointer maths has to undo it. */
  const viewRef = useRef<View>({ k: 1, tx: 0, ty: 0 });
  /**
   * Whether the view still belongs to the fit rather than to the user. Once
   * they zoom or pan it is theirs, and re-fitting under them on the next
   * repaint — a selection, a settling tick — would yank the map away mid-read.
   */
  const autoFitRef = useRef(true);
  const insetsRef = useRef(insets);
  insetsRef.current = insets;

  // Who lights up when a node is selected. All three kinds count: selecting a
  // paper and watching the works it builds on stay dimmed would be the exact
  // opposite of what the selection is for.
  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const join = (a: string, b: string) => {
      if (!map.has(a)) map.set(a, new Set());
      if (!map.has(b)) map.set(b, new Set());
      map.get(a)!.add(b);
      map.get(b)!.add(a);
    };
    for (const e of model.edges) join(e.a, e.b);
    for (const c of model.cites) join(c.from, c.to);
    for (const m of model.mentions) join(m.from, m.to);
    return map;
  }, [model]);

  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const q = query.trim().toLowerCase();
  /** Ids whose title contains the query. Empty query matches nothing. */
  const matches = useMemo(() => {
    if (!q) return EMPTY_SET;
    return new Set(model.nodes.filter((n) => n.title.toLowerCase().includes(q)).map((n) => n.id));
  }, [model, q]);

  // Tell the page how many there are, so the toolbar can say "3 matches" rather
  // than leaving a dimmed map as the only feedback a search happened.
  useEffect(() => {
    onMatchCount?.(q ? matches.size : null);
  }, [matches, q, onMatchCount]);

  // The hook needs paint and paint needs the hook's state ref, so one side has
  // to be indirect. A trampoline keeps the hook's signature honest.
  const paintRef = useRef<() => void>(() => {});
  const { stateRef, clusters, reheat, moveFrom } = useGraphLayout(
    model,
    () => paintRef.current(),
    homes,
    promoted,
  );

  // cluster key -> member ids, and id -> layout index, both rebuilt only when
  // the model changes. The paint loop must not allocate.
  const clusterMembers = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const [id, key] of clusters.byNode) {
      const list = out.get(key);
      if (list) list.push(id);
      else out.set(key, [id]);
    }
    return out;
  }, [clusters]);

  const indexById = useMemo(
    () => new Map(model.nodes.map((n, i) => [n.id, i])),
    [model],
  );

  const maxRadius = useMemo(
    () => model.nodes.reduce((max, n) => Math.max(max, radiusFor(n.degree, n.kind, promoted.has(n.id))), 0),
    [model, promoted],
  );

  /**
   * The transform that shows the whole graph.
   *
   * The simulation bounds the graph in its own units but has no idea how big
   * the window is, so a library with many topics spreads past the edges — the
   * "half the graph is off-screen" problem. Measured from where the nodes
   * actually are, not from the worst-case bound: fitting the box the graph
   * *could* occupy shrinks it further than needed, and every pixel lost that
   * way costs a label.
   *
   * The insets are why this is not simply the window: the inspector is a fixed
   * 320px panel over the right edge, so centring on the window meant selecting
   * a node near that edge slid a panel over the very thing you selected.
   */
  const fitView = useCallback(
    (state: LayoutState, w: number, h: number): View => {
      const { left, right, bottom } = insetsRef.current;
      const availW = Math.max(1, w - left - right);
      // The axis needs a strip of its own, or the oldest column sits on it.
      const availH = Math.max(1, h - bottom - (axis ? AXIS_HEIGHT : 0));

      let spanX = 1;
      let spanY = 1;
      for (const n of state.nodes) {
        spanX = Math.max(spanX, Math.abs(n.x));
        spanY = Math.max(spanY, Math.abs(n.y));
      }
      // Labels stick out past the disc they belong to, and in lineage mode
      // every node carries one — so the outermost column's title ran off the
      // edge of a view that had only reserved room for the node itself.
      // Elsewhere most labels are culled, so paying for them would shrink the
      // map for nothing.
      const sideMargin = homes ? LABEL_FIT_MARGIN : 0;
      const margin = FIT_MARGIN + maxRadius;
      // Scaling up is allowed, but only a little. A small library should use
      // the page rather than huddle in the middle — the extra separation is
      // what lets more titles fit — while a hard ceiling stops three nodes from
      // being blown across a 27-inch display.
      const k = clampZoom(
        Math.min(
          MAX_FIT_SCALE,
          (availW / 2 - margin - sideMargin) / spanX,
          (availH / 2 - margin) / spanY,
        ),
      );
      return { k, tx: left + availW / 2, ty: availH / 2 };
    },
    [maxRadius, homes, axis],
  );

  const paint = useCallback(() => {
    const state = stateRef.current;
    const canvas = canvasRef.current;
    const layer = layerRef.current;
    if (!state || !canvas || !layer) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // While the view still belongs to the fit, recompute it — the graph is
    // settling, the window may have resized, and the inspector may have opened.
    // Once the user has zoomed or panned, their view stands.
    if (autoFitRef.current) viewRef.current = fitView(state, w, h);
    const { k: scale, tx: ox, ty: oy } = viewRef.current;

    // The discs scale with the view, so the layer has to know the factor.
    layer.style.setProperty('--gr-zoom', String(scale));

    const sel = selectedRef.current;
    const lit = sel ? neighbors.get(sel) : null;

    // Neighbourhood names, behind everything. Drawn from the live positions
    // rather than the seeded centre so the label sits on the cluster as it
    // actually settled — a name floating away from its region is worse than
    // no name at all.
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colorsRef.current.region;

    // Biggest region first, so when two headings want the same space the one
    // naming more of the map keeps it.
    const regions = homes
      ? []
      : [...clusterMembers.entries()].sort((a, b) => b[1].length - a[1].length);
    const takenRegions: Box[] = [];

    for (const [key, ids] of regions) {
      let sx = 0;
      let top = Infinity;
      let n = 0;
      for (const id of ids) {
        const node = state.nodes[indexById.get(id) ?? -1];
        if (!node) continue;
        sx += node.x;
        top = Math.min(top, node.y - node.r);
        n += 1;
      }
      if (n < 2) continue;
      // Scaled by how much of the map the neighbourhood occupies, so a big
      // region reads as a heading and a small one does not shout.
      const size = Math.min(34, 15 + Math.sqrt(n) * 4);
      // Canvas cannot read a CSS custom property, so the family is spelled out
      // — it has to match --font-sans or the regions read as a different page.
      ctx.font = `700 ${size}px 'Atkinson Hyperlegible', system-ui, sans-serif`;
      const text = key.toUpperCase();
      const width = ctx.measureText(text).width;
      // Above the topmost node, never at the centroid: a heading drawn through
      // the middle of its own cluster sits on top of the titles it is meant to
      // introduce, and both become harder to read than either alone.
      const cx = (sx / n) * scale + ox;
      const cy = top * scale + oy - size * 0.9;
      const box = { x: cx - width / 2, y: cy - size / 2, w: width, h: size };

      // Two headings on top of each other are less readable than one heading
      // and a nameless region — the same trade `placeLabels` already makes for
      // node titles, and what a narrow window made unavoidable.
      if (takenRegions.some((t) => overlaps(box, t))) continue;
      takenRegions.push(box);

      ctx.globalAlpha = 0.3;
      ctx.fillText(text, cx, cy);
    }

    // The time axis, in lineage mode. `yearHomes` lays the works out in columns
    // by year and the view is built entirely on that reading, but nothing drew
    // it — so the user saw columns and had to guess that x was time. A rule
    // along the bottom with a tick per column says it once, cheaply.
    if (axis && axis.length > 0) {
      const baseline = h - AXIS_HEIGHT + 8;
      ctx.font = `600 11px 'Atkinson Hyperlegible', system-ui, sans-serif`;
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = colorsRef.current.region;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, baseline);
      ctx.lineTo(w, baseline);
      ctx.stroke();

      // Same greedy rule as the region headings: a tick that would land on the
      // last one is dropped rather than drawn over it, so a zoomed-out lineage
      // thins its axis instead of smearing it.
      let lastRight = -Infinity;
      for (const tick of axis) {
        const tx = tick.x * scale + ox;
        if (tx < 0 || tx > w) continue;
        const half = ctx.measureText(tick.label).width / 2;
        if (tx - half < lastRight + 10) continue;
        lastRight = tx + half;
        ctx.beginPath();
        ctx.moveTo(tx, baseline);
        ctx.lineTo(tx, baseline + 4);
        ctx.stroke();
        ctx.fillText(tick.label, tx, baseline + 13);
      }
    }
    ctx.restore();

    // Batched paths, not one stroke per edge. At 2500 edges and 60fps the
    // difference between this and per-edge strokes is the whole frame budget.
    //
    // Three channels, drawn back to front in order of what they claim.
    // Similarity is context and goes underneath; derivation is the content and
    // goes on top with an arrowhead. They are never pooled into one path: that
    // is what "one visual channel per variable" means in practice.
    const rest = new Path2D();
    const strong = new Path2D();
    const allowedReasons = MODE_REASONS[connectionMode];
    if (allowedReasons.size > 0) {
      for (const e of model.edges) {
        if (!e.reasons.some((reason) => allowedReasons.has(reason))) continue;
        const a = state.nodes[indexById.get(e.a) ?? -1];
        const b = state.nodes[indexById.get(e.b) ?? -1];
        if (!a || !b) continue;
        const incident = sel !== null && (a.id === sel || b.id === sel);
        const path = incident ? strong : rest;
        path.moveTo(a.x * scale + ox, a.y * scale + oy);
        path.lineTo(b.x * scale + ox, b.y * scale + oy);
      }
      ctx.lineWidth = 1;
      // Dimmer than it was. These now sit behind two channels that mean more,
      // and the old weight made the map read as a mesh rather than a lineage.
      ctx.globalAlpha = sel ? 0.14 : 0.4;
      ctx.strokeStyle = colorsRef.current.edge;
      ctx.stroke(rest);
      // Selection-incident similarity: louder and darker, not a different hue.
      // These used to be stroked in --accent, which contradicted the rule the
      // rest of the page keeps — accent means selected, and nothing else — and
      // put a fourth colour on a canvas that already has three channels.
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = colorsRef.current.cite;
      ctx.stroke(strong);
      ctx.globalAlpha = 1;
    }

    // A recording naming a paper. Dashed, because it is the one inferred edge
    // here — a machine read a transcript — and a dashed line is the oldest
    // convention there is for "this connection is claimed, not asserted".
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = sel ? 0.4 : 0.75;
    ctx.strokeStyle = colorsRef.current.mention;
    const mentions = new Path2D();
    for (const m of model.mentions) {
      const a = state.nodes[indexById.get(m.from) ?? -1];
      const b = state.nodes[indexById.get(m.to) ?? -1];
      if (!a || !b) continue;
      mentions.moveTo(a.x * scale + ox, a.y * scale + oy);
      mentions.lineTo(b.x * scale + ox, b.y * scale + oy);
    }
    ctx.stroke(mentions);
    ctx.restore();

    // Citations last and loudest: solid, with a head at the cited end. The
    // arrow is the whole point — an undirected line between two papers says
    // they are related, which was already obvious and never the question.
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = colorsRef.current.cite;
    ctx.fillStyle = colorsRef.current.cite;
    for (const c of model.cites) {
      const a = state.nodes[indexById.get(c.from) ?? -1];
      const b = state.nodes[indexById.get(c.to) ?? -1];
      if (!a || !b) continue;
      const incident = sel !== null && (a.id === sel || b.id === sel);
      ctx.globalAlpha = sel === null ? 0.85 : incident ? 1 : 0.18;
      drawArrow(
        ctx,
        a.x * scale + ox,
        a.y * scale + oy,
        b.x * scale + ox,
        b.y * scale + oy,
        // The disc scales with the view, so the head has to stop at the scaled
        // edge or it lands inside the node at any zoom but 1.
        b.r * scale,
      );
    }
    ctx.globalAlpha = 1;

    // One transform write per <li> — compositor work only, no layout, no paint.
    // The <li> is the positioned element; the button inside it is centred on
    // that point by a negative margin.
    const children = layer.children;
    for (let i = 0; i < state.nodes.length; i++) {
      const el = children[i] as HTMLElement | undefined;
      if (!el) continue;
      const n = state.nodes[i];
      el.style.transform = `translate3d(${n.x * scale + ox}px, ${n.y * scale + oy}px, 0)`;
      const dim = sel !== null && n.id !== sel && !lit?.has(n.id);
      el.dataset.dim = dim ? 'true' : 'false';
    }

    // Only once the graph is at rest: this forces a layout read, and a label
    // placed mid-flight would be wrong by the next frame anyway.
    if (state.alpha < ALPHA_REST) placeLabels(state, layer, sel, scale);
  }, [model, connectionMode, neighbors, stateRef, clusterMembers, indexById, fitView, homes, axis]);
  paintRef.current = paint;

  // Canvas cannot read CSS custom properties, so mirror the two it needs and
  // refresh them whenever the theme flips.
  useEffect(() => {
    const read = () => {
      const style = getComputedStyle(document.documentElement);
      colorsRef.current = {
        // --border is tuned for a hairline against a surface; over the page
        // wash it disappears. --text-faint is the lightest token that still
        // reads as a line in both themes.
        edge: style.getPropertyValue('--text-faint').trim() || '#b3b3b3',
        region: style.getPropertyValue('--text-muted').trim() || '#909090',
        // Edges are the product, so the citation layer borrows the body text
        // colour rather than a hairline token — it has to survive being the
        // thing the eye follows across the map.
        cite: style.getPropertyValue('--text-secondary').trim() || '#525252',
        mention: style.getPropertyValue('--gr-mention').trim() || '#8b7fd4',
      };
      paint();
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [paint]);

  useEffect(() => {
    const onResize = () => paint();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [paint]);

  useEffect(() => {
    paint();
  }, [selected, paint]);

  const nodeIndex = useCallback(
    (id: string) => model.nodes.findIndex((n) => n.id === id),
    [model],
  );

  /**
   * A client point in the simulation's own coordinates. The one place the view
   * transform is inverted — node drags and cursor-anchored zoom both need it,
   * and two hand-rolled inversions is how one of them ends up subtly wrong.
   */
  const toGraphSpace = useCallback((clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const { k, tx, ty } = viewRef.current;
    return {
      x: ((clientX - (rect?.left ?? 0)) - tx) / k,
      y: ((clientY - (rect?.top ?? 0)) - ty) / k,
    };
  }, []);

  /** Take the view over from the fit and repaint. */
  const setView = useCallback(
    (next: View) => {
      autoFitRef.current = false;
      viewRef.current = next;
      paintRef.current();
    },
    [],
  );

  const fit = useCallback(() => {
    const state = stateRef.current;
    const canvas = canvasRef.current;
    if (!state || !canvas) return;
    autoFitRef.current = true;
    viewRef.current = fitView(state, canvas.clientWidth, canvas.clientHeight);
    paintRef.current();
  }, [fitView, stateRef]);

  /**
   * Put a set of nodes on screen, filling the usable box. What "search"
   * finally means, now that there is a viewport to move: the old behaviour
   * dimmed everything else and left the match wherever it happened to be,
   * which on a map bigger than the window could be off-screen entirely.
   */
  const frame = useCallback(
    (ids: ReadonlySet<string>) => {
      const state = stateRef.current;
      const canvas = canvasRef.current;
      if (!state || !canvas || ids.size === 0) return;

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of state.nodes) {
        if (!ids.has(n.id)) continue;
        minX = Math.min(minX, n.x - n.r);
        minY = Math.min(minY, n.y - n.r);
        maxX = Math.max(maxX, n.x + n.r);
        maxY = Math.max(maxY, n.y + n.r);
      }
      if (minX === Infinity) return;

      const { left, right, bottom } = insetsRef.current;
      const availW = Math.max(1, canvas.clientWidth - left - right);
      const availH = Math.max(1, canvas.clientHeight - bottom);
      // A single match has no extent, so the span floor is what stops one node
      // from being magnified to MAX_ZOOM and filling the screen.
      const spanX = Math.max(maxX - minX, 240);
      const spanY = Math.max(maxY - minY, 180);
      const k = clampZoom(
        Math.min((availW - FIT_MARGIN * 2) / spanX, (availH - FIT_MARGIN * 2) / spanY),
      );
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      setView({
        k,
        tx: left + availW / 2 - cx * k,
        ty: availH / 2 - cy * k,
      });
    },
    [setView, stateRef],
  );

  // Edge-triggered on the nonce, so framing happens when the page asks and not
  // on every keystroke or repaint.
  const seenFrameNonce = useRef(frameMatchesNonce);
  useEffect(() => {
    if (frameMatchesNonce === seenFrameNonce.current) return;
    seenFrameNonce.current = frameMatchesNonce;
    frame(matches);
  }, [frameMatchesNonce, frame, matches]);

  // Kept separate from selected: clicking around must never keep snapping the
  // viewport, while an assistant instruction explicitly promises a centre.
  // Start empty rather than at the prop value: the graph may mount only after
  // an assistant has already selected a node, and that first focus still has
  // to frame it.
  const seenFocusNonce = useRef<number | null>(null);
  useEffect(() => {
    if (focusNonce === seenFocusNonce.current) return;
    seenFocusNonce.current = focusNonce;
    if (focusId) frame(new Set([focusId]));
  }, [focusNonce, focusId, frame]);

  /** Zoom about a fixed screen point, so what is under it stays under it. */
  const zoomAbout = useCallback(
    (factor: number, screenX: number, screenY: number) => {
      const { k, tx, ty } = viewRef.current;
      const next = clampZoom(k * factor);
      if (next === k) return;
      // Solve for the translation that keeps the graph point under the cursor
      // pinned: (screen - t) / k must be equal before and after.
      setView({
        k: next,
        tx: screenX - ((screenX - tx) / k) * next,
        ty: screenY - ((screenY - ty) / k) * next,
      });
    },
    [setView],
  );

  /** Zoom about the middle of the canvas — what the +/− buttons mean. */
  const zoomBy = useCallback(
    (factor: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      zoomAbout(factor, canvas.clientWidth / 2, canvas.clientHeight / 2);
    },
    [zoomAbout],
  );

  /**
   * Release every pinned node and let the simulation have another go. Without
   * this, alt-drag was a one-way door: pins ossify a layout into something that
   * no longer reflects the data, and only a page reload undid them.
   */
  const resetLayout = useCallback(() => {
    const state = stateRef.current;
    if (!state) return;
    // Lineage mode pins every node to a year column on purpose — that is the
    // view, not an accident of dragging, so there is nothing to release.
    if (homes) return;
    for (const n of state.nodes) n.pinned = false;
    autoFitRef.current = true;
    reheat(0.6);
  }, [homes, reheat, stateRef]);

  // Wheel zoom. Attached by hand rather than via onWheel because React's
  // listener is passive, and a passive listener cannot preventDefault — which
  // means the page scrolls (or the browser zooms, on a pinch) instead.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      zoomAbout(
        Math.exp(-e.deltaY * ZOOM_PER_PIXEL),
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, [zoomAbout]);

  // A new model is a new map, so the user's framing of the old one no longer
  // means anything — fit it again rather than leaving them zoomed into where a
  // cluster used to be.
  useEffect(() => {
    autoFitRef.current = true;
  }, [model, homes]);

  function onPointerDown(e: React.PointerEvent) {
    const state = stateRef.current;
    if (!state) return;
    const button = (e.target as HTMLElement).closest<HTMLElement>('.gr-node');

    // Empty background: pan. This is the gesture that makes a zoomed-in map
    // navigable, so it is the default rather than something modifier-gated.
    if (!button) {
      gestureRef.current = { kind: 'pan', pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    const index = nodeIndex(button.dataset.id!);
    if (index < 0) return;
    gestureRef.current = { kind: 'node', index, pointerId: e.pointerId };
    state.nodes[index].pinned = true;
    button.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const gesture = gestureRef.current;
    const state = stateRef.current;
    if (!gesture || !state || e.pointerId !== gesture.pointerId) return;

    if (gesture.kind === 'pan') {
      const { k, tx, ty } = viewRef.current;
      setView({ k, tx: tx + (e.clientX - gesture.lastX), ty: ty + (e.clientY - gesture.lastY) });
      gesture.lastX = e.clientX;
      gesture.lastY = e.clientY;
      return;
    }

    const node = state.nodes[gesture.index];
    // Undo the view transform, or a drag lands the node somewhere else entirely
    // at any zoom but 1.
    const point = toGraphSpace(e.clientX, e.clientY);
    node.x = point.x;
    node.y = point.y;
    node.vx = 0;
    node.vy = 0;
    reheat();
  }

  function endDrag(e: React.PointerEvent) {
    const gesture = gestureRef.current;
    if (!gesture || !stateRef.current) return;
    // Unpin on release: permanent pins slowly ossify a layout into something
    // that no longer reflects the data. Alt-drag keeps it put for the session,
    // and Reset undoes that.
    if (gesture.kind === 'node') stateRef.current.nodes[gesture.index].pinned = e.altKey;
    gestureRef.current = null;
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const id = (e.target as HTMLElement).closest<HTMLElement>('.gr-node')?.dataset.id;
    if (!id) return;
    const dir =
      e.key === 'ArrowUp'
        ? 'up'
        : e.key === 'ArrowDown'
          ? 'down'
          : e.key === 'ArrowLeft'
            ? 'left'
            : e.key === 'ArrowRight'
              ? 'right'
              : null;
    if (dir) {
      e.preventDefault();
      const next = moveFrom(id, dir);
      if (next) {
        onSelect(next);
        layerRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next)}"]`)?.focus();
      }
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      onSelect(id);
    }
  }

  return (
    <div className="gr-canvas-wrap" ref={wrapRef}>
      <canvas className="gr-edges" ref={canvasRef} aria-hidden="true" />
      <ul
        className="gr-nodes"
        ref={layerRef}
        role="list"
        aria-label="Knowledge graph"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(e) => {
          // Background only — on a node this is "open", handled below.
          if (!(e.target as HTMLElement).closest('.gr-node')) fit();
        }}
        onKeyDown={onKeyDown}
      >
        {model.nodes.map((n, i) => (
          <li key={n.id}>
            <button
              className="gr-node"
              data-id={n.id}
              data-kind={n.kind}
              data-level={n.level}
              data-degree={n.degree}
              data-selected={n.id === selected ? 'true' : undefined}
              data-faded={q !== '' && !matches.has(n.id) ? 'true' : undefined}
              data-hit={q !== '' && matches.has(n.id) ? 'true' : undefined}
              data-promoted={promoted.has(n.id) ? 'true' : undefined}
              data-label={
                // Borrowed papers label on hover and selection only — fifty
                // citation titles at once is noise on the whole map. In a
                // lineage they are the content, and an unlabelled square is
                // exactly the thing that made the old view unreadable. A
                // promoted ghost is named too: it is being recommended, and an
                // anonymous recommendation is not one.
                (n.kind !== 'external' && n.degree >= LABEL_MIN_DEGREE) ||
                promoted.has(n.id) ||
                n.id === selected ||
                // A search hit is named whatever it is: dimming the rest of the
                // map and leaving the one thing the user asked for as an
                // anonymous dot is not finding it.
                matches.has(n.id) ||
                homes !== null
                  ? 'always'
                  : undefined
              }
              style={
                { '--gr-r': `${radiusFor(n.degree, n.kind, promoted.has(n.id))}px` } as React.CSSProperties
              }
              // Roving tabindex: 400 tab stops is worse than none.
              tabIndex={n.id === selected || (selected === null && i === 0) ? 0 : -1}
              aria-label={`${n.title}. ${KIND_LABEL[n.kind]}. ${n.degree} connection${n.degree === 1 ? '' : 's'}. Enter to open.`}
              // Click selects, and the inspector's Open button is the only way
              // to open. Double-click used to be it: undiscoverable, no touch
              // equivalent, and the select-toggle fired twice on the way — so
              // the node you had just opened ended up deselected behind you.
              onClick={() => onSelect(n.id === selected ? null : n.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onOpen(n);
              }}
            >
              <span className="gr-node-label">{n.title}</span>
            </button>
          </li>
        ))}
      </ul>

      {/* Bottom-right, clear of the inspector via --gr-chrome-right. Small and
          quiet: the map is the content, and these exist so that a zoomed or
          dragged view is never a dead end. */}
      <div className="gr-view-controls" role="group" aria-label="View">
        <button className="gr-view-btn" title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>
          +
        </button>
        <button className="gr-view-btn" title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>
          −
        </button>
        <button className="gr-view-btn" title="Fit the whole map (or double-click the background)" onClick={fit}>
          Fit
        </button>
        {!homes && (
          <button
            className="gr-view-btn"
            title="Release dragged nodes and lay the map out again"
            onClick={resetLayout}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
