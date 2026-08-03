import { describe, expect, it } from 'vitest';
import { nearestInDirection, seedLayout, settle, step, type LayoutState } from './graphLayout';

function ids(n: number): { id: string; r: number }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `n${i}`, r: 8 }));
}

function energy(s: LayoutState): number {
  return s.nodes.reduce((sum, n) => sum + n.vx * n.vx + n.vy * n.vy, 0);
}

function finite(s: LayoutState): boolean {
  return s.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
}

describe('step', () => {
  // The classic force-layout crash: repulsion divides by distance, so two
  // nodes at the same point produce Infinity and then NaN, and every node
  // downstream of the next tick is NaN too. Two bookmarks saved in the same
  // millisecond can seed into the same slot, so this is not hypothetical.
  it('survives two nodes at exactly the same position', () => {
    const s = seedLayout(ids(2), []);
    s.nodes[1].x = s.nodes[0].x;
    s.nodes[1].y = s.nodes[0].y;

    for (let i = 0; i < 20; i++) step(s);

    expect(finite(s)).toBe(true);
    // and they must have actually pushed apart, not merely stayed finite
    expect(Math.hypot(s.nodes[0].x - s.nodes[1].x, s.nodes[0].y - s.nodes[1].y)).toBeGreaterThan(0);
  });

  it('leaves pinned nodes exactly where they are', () => {
    const s = seedLayout(ids(6), [{ a: 'n0', b: 'n1', weight: 1, reasons: ['deck'] }]);
    s.nodes[0].pinned = true;
    const { x, y } = s.nodes[0];

    for (let i = 0; i < 30; i++) step(s);

    expect(s.nodes[0].x).toBe(x);
    expect(s.nodes[0].y).toBe(y);
  });

  it('converges — kinetic energy falls as alpha decays', () => {
    const s = seedLayout(
      ids(20),
      Array.from({ length: 10 }, (_, i) => ({
        a: `n${i}`,
        b: `n${i + 10}`,
        weight: 1,
        reasons: ['tag' as const],
      })),
    );
    for (let i = 0; i < 20; i++) step(s);
    const early = energy(s);
    for (let i = 0; i < 280; i++) step(s);

    expect(energy(s)).toBeLessThan(early);
    expect(s.alpha).toBeLessThan(0.02);
  });

  // The spring used to have a fixed rest length shorter than two node
  // diameters, so a deck's papers settled drawn on top of each other.
  it('never lets two nodes overlap, however strong the link', () => {
    const nodes = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, r: 20 }));
    const edges = nodes.flatMap((a, i) =>
      nodes.slice(i + 1).map((b) => ({ a: a.id, b: b.id, weight: 1, reasons: ['deck' as const] })),
    );
    const s = settle(seedLayout(nodes, edges), 400);

    for (let i = 0; i < s.nodes.length; i++) {
      for (let j = i + 1; j < s.nodes.length; j++) {
        const gap = Math.hypot(s.nodes[i].x - s.nodes[j].x, s.nodes[i].y - s.nodes[j].y);
        expect(gap).toBeGreaterThanOrEqual(s.nodes[i].r + s.nodes[j].r);
      }
    }
  });

  it('pulls connected nodes closer than unconnected ones', () => {
    // n0-n1 linked; n2 linked to nothing. The one behavioral claim the whole
    // visualization rests on.
    const s = settle(seedLayout(ids(3), [{ a: 'n0', b: 'n1', weight: 1, reasons: ['deck'] }]), 400);
    const [a, b, c] = s.nodes;

    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(Math.hypot(a.x - c.x, a.y - c.y));
  });
});

describe('seedLayout', () => {
  it('is deterministic — the same ids seed identically', () => {
    expect(seedLayout(ids(30), []).nodes).toEqual(seedLayout(ids(30), []).nodes);
  });

  it('keeps existing nodes in place when one is appended', () => {
    // Spatial memory only works if a node lands where it landed last time.
    const before = seedLayout(ids(10), []).nodes;
    const after = seedLayout([...ids(10), { id: 'n10', r: 8 }], []).nodes;

    expect(after.slice(0, 10)).toEqual(before);
  });

  it('separates every seeded node', () => {
    const s = seedLayout(ids(50), []);
    for (let i = 0; i < s.nodes.length; i++) {
      for (let j = i + 1; j < s.nodes.length; j++) {
        expect(Math.hypot(s.nodes[i].x - s.nodes[j].x, s.nodes[i].y - s.nodes[j].y)).toBeGreaterThan(
          0,
        );
      }
    }
  });

  it('resolves edges to indices and drops ones naming a missing node', () => {
    const s = seedLayout(ids(3), [
      { a: 'n0', b: 'n1', weight: 1, reasons: ['deck'] },
      { a: 'n0', b: 'gone', weight: 1, reasons: ['deck'] },
    ]);

    expect(s.edges).toEqual([{ a: 0, b: 1, w: 1 }]);
  });
});

describe('bounds', () => {
  // The bug this fixes, straight off a screenshot: a node with no edges feels
  // only repulsion, and CENTERING at 0.002 never wins against it. Half the
  // graph ends up past the edge of the window where it cannot be seen, reached
  // or scrolled to.
  it('keeps unconnected nodes inside the box however long it runs', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, r: 10 }));
    const s = settle(seedLayout(nodes, []), 1200);

    for (const n of s.nodes) {
      expect(Math.abs(n.x)).toBeLessThanOrEqual(s.bound);
      expect(Math.abs(n.y)).toBeLessThanOrEqual(s.bound);
    }
  });

  it('sizes the box to the graph rather than a fixed guess', () => {
    const small = seedLayout([{ id: 'a', r: 10 }], []);
    const large = seedLayout(
      Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, r: 10 })),
      [],
    );

    expect(large.bound).toBeGreaterThan(small.bound);
  });
});

describe('cluster pull', () => {
  it('draws a node to its own neighbourhood instead of the origin', () => {
    const home = { x: 400, y: 0 };
    const s = settle(seedLayout([{ id: 'a', r: 10, home }], []), 400);

    expect(s.nodes[0].x).toBeGreaterThan(300);
  });

  // The whole point of the change: two topics must end up as two places on the
  // page, not one blob with a mixed label.
  it('separates two neighbourhoods that share no edges', () => {
    const left = { x: -300, y: 0 };
    const right = { x: 300, y: 0 };
    const s = settle(
      seedLayout(
        [
          { id: 'l1', r: 10, home: left },
          { id: 'l2', r: 10, home: left },
          { id: 'r1', r: 10, home: right },
          { id: 'r2', r: 10, home: right },
        ],
        [],
      ),
      400,
    );

    const lx = (s.nodes[0].x + s.nodes[1].x) / 2;
    const rx = (s.nodes[2].x + s.nodes[3].x) / 2;
    expect(rx - lx).toBeGreaterThan(300);
  });

  it('still lets a link pull two nodes of different topics together', () => {
    const s = settle(
      seedLayout(
        [
          { id: 'a', r: 10, home: { x: -300, y: 0 } },
          { id: 'b', r: 10, home: { x: 300, y: 0 } },
        ],
        [{ a: 'a', b: 'b', weight: 1, reasons: ['deck'] }],
      ),
      400,
    );

    // Not adjacent — the topics still pull them apart — but far closer than the
    // 600 units between their neighbourhoods.
    expect(Math.abs(s.nodes[1].x - s.nodes[0].x)).toBeLessThan(600);
  });
});

describe('nearestInDirection', () => {
  const s: LayoutState = {
    nodes: [
      { id: 'c', x: 0, y: 0, vx: 0, vy: 0, r: 8, pinned: false, home: null },
      { id: 'right', x: 100, y: 0, vx: 0, vy: 0, r: 8, pinned: false, home: null },
      { id: 'left', x: -100, y: 0, vx: 0, vy: 0, r: 8, pinned: false, home: null },
      { id: 'up', x: 0, y: -100, vx: 0, vy: 0, r: 8, pinned: false, home: null },
      { id: 'down', x: 0, y: 100, vx: 0, vy: 0, r: 8, pinned: false, home: null },
      { id: 'far-right', x: 400, y: 0, vx: 0, vy: 0, r: 8, pinned: false, home: null },
    ],
    edges: [],
    alpha: 0,
    bound: 1000,
  };

  it('picks the nearest node in each direction', () => {
    expect(nearestInDirection(s, 0, 'right')).toBe(1);
    expect(nearestInDirection(s, 0, 'left')).toBe(2);
    expect(nearestInDirection(s, 0, 'up')).toBe(3);
    expect(nearestInDirection(s, 0, 'down')).toBe(4);
  });

  it('returns null when the cone is empty', () => {
    expect(nearestInDirection(s, 3, 'up')).toBe(null);
  });

  it('ignores nodes outside the cone', () => {
    // From 'left', everything else is to the right — but 'up' and 'down' sit
    // at ~45°, inside the ±60° cone, and are nearer than 'right'.
    expect(nearestInDirection(s, 5, 'left')).toBe(1);
  });
});
