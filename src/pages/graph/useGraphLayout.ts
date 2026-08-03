import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ALPHA_REST,
  nearestInDirection,
  seedLayout,
  settle,
  step,
  type LayoutState,
} from '../../shared/graphLayout';
import { GRAPH_EXTERNAL_RADIUS, GRAPH_QUEUE_RADIUS } from '../../shared/constants';
import { buildClusters, type ClusterLayout } from '../../shared/graphClusters';
import type { GraphModel } from '../../shared/graphModel';
import type { GraphNodeKind } from '../../shared/types';

/**
 * Owns the simulation and the frame loop, deliberately outside React: at 60fps
 * a setState per tick would re-render the whole node list sixty times a second.
 * Positions are written straight to the DOM as transforms instead, and React
 * only hears about selection.
 */

/** Ticks run before the first paint, so the graph is never seen exploding. */
const PREROLL_TICKS = 60;
/** Enough for the reduced-motion path to reach the same rest state. */
const SETTLED_TICKS = 340;
/** Where the visible animation starts. Reaches ALPHA_REST in ~74 ticks (~1.2s). */
const START_ALPHA = 0.6;
/** A drag only needs to nudge its own neighbourhood loose. */
const DRAG_ALPHA = 0.25;

/**
 * What a citation and a mention pull like.
 *
 * Positioning only, and the one place the three edge kinds are deliberately
 * pooled: the simulation asks "should these two sit near each other", and for
 * all three the answer is yes. Storage and rendering keep them apart, because
 * those ask different questions — what is true, and what to draw. A citation
 * pulls hardest of the inferred kinds, since derivation is the structure the
 * map is meant to show.
 */
const SPRING_CITES = 0.7;
const SPRING_MENTION = 0.5;

/**
 * Node radius from degree — well-connected things read as bigger. Borrowed
 * papers are fixed and small regardless: they are context, not content, and a
 * constant size also keeps them from crowding the user's own nodes.
 */
export function radiusFor(degree: number, kind?: GraphNodeKind, promoted = false): number {
  // A ghost several of your papers converge on has stopped being context and
  // become a recommendation, so it is drawn nearer the size of a real node.
  if (kind === 'external') return promoted ? GRAPH_QUEUE_RADIUS : GRAPH_EXTERNAL_RADIUS;
  return Math.min(22, 11 + Math.sqrt(degree) * 3.5);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface GraphLayout {
  stateRef: React.RefObject<LayoutState | null>;
  /** Which neighbourhood each node is in, and where each one sits */
  clusters: ClusterLayout;
  /** Bumped whenever positions are rebuilt, so paint effects can resubscribe */
  generation: number;
  reheat: (alpha?: number) => void;
  /** Index of a node id, for keyboard navigation */
  indexOf: (id: string) => number;
  moveFrom: (id: string, dir: 'up' | 'down' | 'left' | 'right') => string | null;
}

/**
 * `homes` overrides where nodes are pulled to. Lineage mode supplies its own
 * (see citationLineage.yearHomes) instead of topic neighbourhoods — the
 * simulation is the same either way, only the targets differ.
 */
export function useGraphLayout(
  model: GraphModel,
  paint: () => void,
  homes: Map<string, { x: number; y: number }> | null = null,
  /** Must match what the canvas draws, or collision resolves at the wrong size */
  promoted: ReadonlySet<string> = new Set(),
): GraphLayout {
  const clusters = useMemo(() => buildClusters(model.nodes, model.edges), [model]);

  // Everything that should hold two nodes together, flattened for the physics.
  // The directed lists lose their direction here on purpose — a spring has no
  // opinion about which end came first, and the arrowheads are drawn from
  // model.cites, which still knows.
  const springs = useMemo(
    () => [
      ...model.edges,
      ...model.cites.map((c) => ({ a: c.from, b: c.to, weight: SPRING_CITES, reasons: [] })),
      ...model.mentions.map((m) => ({ a: m.from, b: m.to, weight: SPRING_MENTION, reasons: [] })),
    ],
    [model],
  );

  const stateRef = useRef<LayoutState | null>(null);
  const rafRef = useRef<number | null>(null);
  const paintRef = useRef(paint);
  const [generation, setGeneration] = useState(0);
  paintRef.current = paint;

  useEffect(() => {
    const state = seedLayout(
      model.nodes.map((n) => ({
        id: n.id,
        r: radiusFor(n.degree, n.kind, promoted.has(n.id)),
        home: homes
          ? (homes.get(n.id) ?? null)
          : (clusters.centres.get(clusters.byNode.get(n.id) ?? '') ?? null),
        // A supplied arrangement is a layout, not a starting guess.
        pinned: homes !== null && homes.has(n.id),
      })),
      springs,
    );
    // Pre-roll before anyone sees it. The spiral seed converges fast, so this
    // costs ~30ms and removes the "cloud of nodes flying apart" opening.
    settle(state, PREROLL_TICKS);

    if (prefersReducedMotion()) {
      // Same seed, same forces, same destination — the setting changes the
      // journey, not where the graph ends up.
      settle(state, SETTLED_TICKS);
      state.alpha = 0;
    } else {
      state.alpha = START_ALPHA;
    }

    stateRef.current = state;
    setGeneration((g) => g + 1);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      stateRef.current = null;
    };
  }, [model, clusters, springs, homes, promoted]);

  // Separate from seeding so a reheat can restart the loop without reseeding.
  const tick = useCallback(() => {
    const state = stateRef.current;
    if (!state) return;
    step(state);
    paintRef.current();
    if (state.alpha < ALPHA_REST) {
      rafRef.current = null;
      document.body.dataset.settled = 'true';
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const reheat = useCallback(
    (alpha = DRAG_ALPHA) => {
      const state = stateRef.current;
      if (!state || prefersReducedMotion()) {
        paintRef.current();
        return;
      }
      state.alpha = Math.max(state.alpha, alpha);
      document.body.dataset.settled = 'false';
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(tick);
    },
    [tick],
  );

  useEffect(() => {
    if (!stateRef.current) return;
    paintRef.current();
    if (stateRef.current.alpha < ALPHA_REST) {
      document.body.dataset.settled = 'true';
      return;
    }
    document.body.dataset.settled = 'false';
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [generation, tick]);

  const indexOf = useCallback(
    (id: string) => stateRef.current?.nodes.findIndex((n) => n.id === id) ?? -1,
    [],
  );

  const moveFrom = useCallback(
    (id: string, dir: 'up' | 'down' | 'left' | 'right') => {
      const state = stateRef.current;
      if (!state) return null;
      const from = state.nodes.findIndex((n) => n.id === id);
      if (from < 0) return null;
      const to = nearestInDirection(state, from, dir);
      return to === null ? null : state.nodes[to].id;
    },
    [],
  );

  return { stateRef, clusters, generation, reheat, indexOf, moveFrom };
}
