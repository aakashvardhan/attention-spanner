import { hash32 } from './ai/cache';
import type { GraphEdge } from './graphModel';

/**
 * A small deterministic force simulation.
 *
 * Hand-rolled rather than d3-force on purpose: d3 seeds with Math.random(),
 * which makes a layout unreproducible and this module untestable without
 * stubbing globals, and it arrives with four sibling packages to solve a
 * 10k-node problem we cap at 400. What is left is ~120 lines of well-understood
 * math, pure and seeded, matching how activity.ts and srs.ts are already built.
 *
 * Everything here mutates in place — the tick loop runs at 60fps and should not
 * allocate.
 */

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Drawn radius; also the collision floor */
  r: number;
  pinned: boolean;
  /** The neighbourhood this node is pulled toward; null = the origin */
  home: { x: number; y: number } | null;
}

/** Edge endpoints resolved to node indices once, so the tick loop never looks up. */
export interface LayoutEdge {
  a: number;
  b: number;
  w: number;
}

export interface LayoutState {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  alpha: number;
  /** Half-extent of the box nodes are kept inside, in layout units */
  bound: number;
}

/** Golden angle: successive points never line up, so the spiral fills evenly. */
const GOLDEN_ANGLE = 2.399963229728653;
const SEED_SPACING = 12;
const REPULSION = 9000;
const SPRING = 0.05;
const CENTERING = 0.002;
/**
 * Pull toward a node's own neighbourhood. Stronger than CENTERING because it
 * has to beat repulsion from every other cluster — this is the force that turns
 * one blob into named regions.
 */
const CLUSTER_PULL = 0.03;
/**
 * Padding inside the bound, so a clamped node is fully visible rather than
 * half off the edge.
 */
const BOUND_PAD = 28;
/** Breathing room between two linked nodes, on top of both their radii. */
const LINK_GAP = 24;
/** Shapes must never touch, however hard their link pulls. */
const COLLISION_PAD = 4;
const VELOCITY_DECAY = 0.6;
const ALPHA_DECAY = 0.955;
/** Below this the layout is visually still; the loop stops rather than idling. */
export const ALPHA_REST = 0.02;
/** Distance floor for repulsion. Without it, coincident nodes divide by zero. */
const MIN_DISTANCE = 1;
/** How far off-axis a node can sit and still count as "that direction" */
const CONE_COS = Math.cos(Math.PI / 3); // ±60°

/** Deterministic ±2px offset, so two nodes never seed onto the same point. */
function jitter(id: string, axis: number): number {
  // hash32 returns base 36, not hex.
  const h = parseInt(hash32(`${id}:${axis}`), 36);
  return (h % 400) / 100 - 2;
}

/**
 * Place nodes on a golden-angle spiral, indexed by position in the list.
 *
 * Two consequences worth the choice: convergence is much faster than from a
 * random cloud because the seed is already well spread, and a node lands in the
 * same neighbourhood on every open — which is what makes the graph memorable,
 * and is why the reduced-motion path can skip the animation without landing
 * somewhere else.
 */
export function seedLayout(
  nodes: { id: string; r: number; home?: { x: number; y: number } | null; pinned?: boolean }[],
  edges: GraphEdge[],
): LayoutState {
  const index = new Map<string, number>();
  const laid: LayoutNode[] = nodes.map((n, i) => {
    index.set(n.id, i);
    const theta = i * GOLDEN_ANGLE;
    const radius = SEED_SPACING * Math.sqrt(i);
    const home = n.home ?? null;
    // A pinned node *is* its home — no seed offset, no jitter. This is how a
    // deliberate arrangement (the citation lineage) coexists with the force
    // layout: the same tick loop runs, but these nodes do not move.
    //
    // Pinning rather than a stronger pull is not a shortcut. A citation edge's
    // spring wants its endpoints about 55 units apart and pulls with roughly a
    // hundred times the force the home pull can answer at column distance, so
    // an arrangement expressed as targets alone collapses into a ring around
    // the centre — which is exactly what it did.
    if (n.pinned) {
      return { id: n.id, x: home?.x ?? 0, y: home?.y ?? 0, vx: 0, vy: 0, r: n.r, pinned: true, home };
    }
    // Seed inside its own neighbourhood rather than at the origin: starting in
    // roughly the right place is most of why this converges quickly, and it is
    // what stops clusters from having to cross each other on the way out.
    return {
      id: n.id,
      x: (home?.x ?? 0) + radius * Math.cos(theta) * (home ? 0.35 : 1) + jitter(n.id, 0),
      y: (home?.y ?? 0) + radius * Math.sin(theta) * (home ? 0.35 : 1) + jitter(n.id, 1),
      vx: 0,
      vy: 0,
      r: n.r,
      pinned: false,
      home,
    };
  });

  const resolved: LayoutEdge[] = [];
  for (const e of edges) {
    const a = index.get(e.a);
    const b = index.get(e.b);
    if (a === undefined || b === undefined) continue;
    resolved.push({ a, b, w: e.weight });
  }

  // How much room this many nodes need. Without a bound, a node with no edges
  // feels only repulsion and accelerates outward forever — which is exactly how
  // half a graph ends up past the edge of the screen.
  const spread = Math.max(...laid.flatMap((n) => [Math.abs(n.x), Math.abs(n.y)]), 0);
  const bound = Math.max(240, spread + 120, 46 * Math.sqrt(laid.length));

  return { nodes: laid, edges: resolved, alpha: 1, bound };
}

/** One tick. O(n²) over pairs — 400 nodes is ~80k pair evaluations, well inside a frame. */
export function step(s: LayoutState, decay = ALPHA_DECAY): void {
  const { nodes, edges } = s;

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.hypot(dx, dy);
      if (dist < MIN_DISTANCE) {
        // Coincident or nearly so. Push along a fixed axis rather than a random
        // one, so the resolution stays deterministic like everything else here.
        dx = MIN_DISTANCE;
        dy = 0;
        dist = MIN_DISTANCE;
      }
      const force = (REPULSION / (dist * dist)) * s.alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;

      // Repulsion alone loses to a strong spring, which is how two linked
      // nodes end up drawn on top of each other. Separate them positionally
      // instead, so overlap is impossible rather than merely discouraged.
      const floor = a.r + b.r + COLLISION_PAD;
      if (dist < floor) {
        const push = (floor - dist) / 2;
        const px = (dx / dist) * push;
        const py = (dy / dist) * push;
        if (!a.pinned) {
          a.x -= px;
          a.y -= py;
        }
        if (!b.pinned) {
          b.x += px;
          b.y += py;
        }
      }
    }
  }

  for (const e of edges) {
    const a = nodes[e.a];
    const b = nodes[e.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.max(Math.hypot(dx, dy), MIN_DISTANCE);
    // Measured from the shapes' edges, not their centres: a fixed rest length
    // that ignores radius is what makes big nodes overlap. Stronger links sit
    // closer, which is what makes a cluster read as a cluster.
    const rest = a.r + b.r + LINK_GAP * (2 - e.w);
    const force = SPRING * (dist - rest) * e.w * s.alpha;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  const limit = s.bound - BOUND_PAD;
  for (const n of nodes) {
    if (n.pinned) {
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    if (n.home) {
      n.vx += (n.home.x - n.x) * CLUSTER_PULL * s.alpha;
      n.vy += (n.home.y - n.y) * CLUSTER_PULL * s.alpha;
    } else {
      n.vx -= n.x * CENTERING * s.alpha;
      n.vy -= n.y * CENTERING * s.alpha;
    }
    n.vx *= VELOCITY_DECAY;
    n.vy *= VELOCITY_DECAY;
    n.x += n.vx;
    n.y += n.vy;

    // Hard walls, not a spring: a node that reaches the edge stops there and
    // loses the velocity that took it out, so it settles against the wall
    // instead of bouncing back into the graph it was pushed out of.
    if (n.x < -limit) {
      n.x = -limit;
      n.vx = 0;
    } else if (n.x > limit) {
      n.x = limit;
      n.vx = 0;
    }
    if (n.y < -limit) {
      n.y = -limit;
      n.vy = 0;
    } else if (n.y > limit) {
      n.y = limit;
      n.vy = 0;
    }
  }

  s.alpha *= decay;
}

/** Run to rest without painting — the reduced-motion path, and every test. */
export function settle(s: LayoutState, ticks: number): LayoutState {
  for (let i = 0; i < ticks; i++) step(s);
  return s;
}

/**
 * The node a cursor key should move to: nearest within a ±60° cone. Distance
 * alone would jump across the graph; the cone keeps arrow keys feeling like
 * direction rather than teleportation.
 */
export function nearestInDirection(
  s: LayoutState,
  from: number,
  dir: 'up' | 'down' | 'left' | 'right',
): number | null {
  const origin = s.nodes[from];
  if (!origin) return null;
  const axis =
    dir === 'right' ? [1, 0] : dir === 'left' ? [-1, 0] : dir === 'up' ? [0, -1] : [0, 1];

  let best: number | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < s.nodes.length; i++) {
    if (i === from) continue;
    const dx = s.nodes[i].x - origin.x;
    const dy = s.nodes[i].y - origin.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) continue;
    if ((dx * axis[0] + dy * axis[1]) / dist < CONE_COS) continue;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}
