import { useEffect, useRef } from 'react';

/**
 * A line-drawn obstacle course along the masthead's bottom lane: a group of stick
 * figures runs it left to right, clearing spikes, vaulting a crate, crawling under a
 * low bar and taking a ramp, then the course loops at the flag.
 *
 * Geometry is in CSS pixels with y measured up from the double rule, so the
 * course and the figure's path are pure functions the test can check: feet
 * never inside an obstacle, head never through the bar. Colours are read from
 * the theme tokens on every frame, so light, dark and a theme switched in
 * Options all follow without a reload. Reduced motion gets one still frame,
 * mid-jump.
 */
export type Kind = 'spikes' | 'crate' | 'bar' | 'ramp';
export interface Obstacle {
  kind: Kind;
  x: number;
}

const TILE = 480;
const PATTERN: Obstacle[] = [
  { kind: 'spikes', x: 40 },
  { kind: 'crate', x: 150 },
  { kind: 'bar', x: 250 },
  { kind: 'ramp', x: 350 },
];
const START = 64; // a run-up before the first obstacle
const FINISH = 40; // flag sits this far in from the right edge

export const SPIKE_H = 6;
export const CRATE = { w: 30, h: 14 };
export const BAR = { w: 50, bottom: 15, h: 6 };
const RAMP = { up: 30, flat: 40, down: 30, h: 10 };

/** Standing height, and crawling height under the bar. */
export const TALL = 20;
export const LOW = 9;

const SPEED = 40; // px per second: a jog, not a sprint
const STRIDE = 22; // px per full leg cycle
const FRAME_MS = 33; // ~30fps is plenty for a background figure
const GAP = 220; // px between runners in the group

/**
 * Where each runner in the group is when the lead has run `x` px. They share a
 * loop from 20px off the left edge to 20px off the right, evenly spaced, at
 * least three of them.
 */
export function runnersAt(x: number, width: number): number[] {
  const loop = width + 40;
  const n = Math.max(3, Math.round(loop / GAP));
  return Array.from({ length: n }, (_, i) => ((((x + (i * loop) / n) % loop) + loop) % loop) - 20);
}

/** Every obstacle that fits before the flag, the pattern repeated. */
export function courseFor(width: number): Obstacle[] {
  const out: Obstacle[] = [];
  for (let t = START; ; t += TILE) {
    for (const o of PATTERN) {
      const x = t + o.x;
      if (x + 100 > width - FINISH) return out;
      out.push({ kind: o.kind, x });
    }
  }
}

/** Height of solid ground at x (crate tops, the ramp); 0 is the rule. */
export function groundAt(x: number, course: Obstacle[]): number {
  for (const o of course) {
    const d = x - o.x;
    if (o.kind === 'crate' && d >= 0 && d <= CRATE.w) return CRATE.h;
    if (o.kind === 'ramp' && d >= 0 && d <= RAMP.up + RAMP.flat + RAMP.down) {
      if (d < RAMP.up) return (RAMP.h * d) / RAMP.up;
      if (d <= RAMP.up + RAMP.flat) return RAMP.h;
      return (RAMP.h * (RAMP.up + RAMP.flat + RAMP.down - d)) / RAMP.down;
    }
  }
  return 0;
}

/** Highest thing a foot must not be inside at x: ground, or the spike tips. */
export function solidAt(x: number, course: Obstacle[]): number {
  for (const o of course) {
    if (o.kind === 'spikes' && x >= o.x && x <= o.x + 40) return SPIKE_H;
  }
  return groundAt(x, course);
}

/** Take-off and landing points (relative to the obstacle) and apex height. */
function jumpsFor(o: Obstacle): [number, number, number][] {
  if (o.kind === 'spikes') return [[o.x - 16, o.x + 56, 16]];
  if (o.kind === 'crate')
    return [
      [o.x - 22, o.x + 4, 6],
      [o.x + 26, o.x + 48, 4],
    ];
  return [];
}

export interface Figure {
  lift: number; // feet above the rule
  air: number; // 0 running, 1 at the top of a jump
  crouch: number; // 0 upright, 1 flat crawl
}

export function figureAt(x: number, course: Obstacle[]): Figure {
  for (const o of course) {
    for (const [a, b, apex] of jumpsFor(o)) {
      if (x > a && x < b) {
        const t = (x - a) / (b - a);
        const from = groundAt(a, course);
        const to = groundAt(b, course);
        return { lift: from + (to - from) * t + apex * 4 * t * (1 - t), air: Math.sin(Math.PI * t), crouch: 0 };
      }
    }
    if (o.kind === 'bar') {
      const d = x - o.x;
      // Down over 18px before the bar, flat under it, back up over 16px after.
      const crouch =
        d < -22 || d > BAR.w + 16 ? 0 : d < -4 ? smooth((d + 22) / 18) : d <= BAR.w + 2 ? 1 : 1 - smooth((d - BAR.w - 2) / 14);
      if (crouch > 0) return { lift: 0, air: 0, crouch };
    }
  }
  return { lift: groundAt(x, course), air: 0, crouch: 0 };
}

/** How tall the figure stands for a given crouch. */
export function heightFor(crouch: number): number {
  return TALL - (TALL - LOW) * crouch;
}

function smooth(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

export type Pt = [number, number];
type Pose = { head: Pt; neck: Pt; hip: Pt; limbs: [Pt, Pt, Pt][] }; // limbs: root, joint, end

/** Joints relative to the feet, y up. Run, tuck and crawl blend by air/crouch. */
export function poseFor(phase: number, f: Figure): Pose {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const run: Pose = {
    head: [2.5, 17.5],
    neck: [1.5, 14.5],
    hip: [0, 8],
    limbs: [
      leg(s, c),
      leg(-s, -c),
      [[1.5, 14], [1.5 - 3 * s, 10.5], [3 - 4 * s, 8.5]],
      [[1.5, 14], [1.5 + 3 * s, 10.5], [3 + 4 * s, 8.5]],
    ],
  };
  const tuck: Pose = {
    head: [3, 16],
    neck: [2, 13],
    hip: [0, 7],
    limbs: [
      [[0, 7], [4, 6], [1, 2.5]],
      [[0, 7], [3, 5], [0, 1.5]],
      [[2, 12.5], [5, 13.5], [7, 15.5]],
      [[2, 12.5], [4, 14.5], [5, 17]],
    ],
  };
  const crawl: Pose = {
    head: [9, 6],
    neck: [6, 5],
    hip: [-5, 4.5],
    limbs: [
      [[-5, 4.5], [-3 + 2 * s, 1.5], [-7 + 2 * s, 0]],
      [[-5, 4.5], [-3 - 2 * s, 1.5], [-7 - 2 * s, 0]],
      [[6, 5], [7 - 2 * s, 2.5], [8 - 2 * s, 0]],
      [[6, 5], [7 + 2 * s, 2.5], [8 + 2 * s, 0]],
    ],
  };
  return mix(mix(run, tuck, f.air), crawl, f.crouch);

  function leg(sn: number, cs: number): [Pt, Pt, Pt] {
    // Knee swings with the stride; the shin trails when the leg comes through.
    const knee: Pt = [3.5 * sn, 8 - 4 + Math.abs(sn) * 0.5];
    const lifted = Math.max(0, cs) * 2.5;
    return [[0, 8], knee, [knee[0] + 1.5 * sn - lifted, lifted]];
  }
}

function mix(a: Pose, b: Pose, t: number): Pose {
  if (t <= 0) return a;
  const p = (u: Pt, v: Pt): Pt => [u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t];
  return {
    head: p(a.head, b.head),
    neck: p(a.neck, b.neck),
    hip: p(a.hip, b.hip),
    limbs: a.limbs.map((l, i) => l.map((j, k) => p(j, b.limbs[i][k])) as [Pt, Pt, Pt]),
  };
}

export function ObstacleCourse() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let course: Obstacle[] = [];
    let width = 0;
    let raf = 0;
    let last = 0;
    let x = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < FRAME_MS) return;
      const dt = last ? Math.min(now - last, 100) : 0;
      last = now;

      const dpr = devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      if (w !== width) {
        width = w;
        course = courseFor(w);
      }
      if (reduced) x = course.length ? course[0].x + 40 : w / 2;
      else x += (SPEED * dt) / 1000;

      const css = getComputedStyle(canvas);
      const color = (token: string) => css.getPropertyValue(token).trim();
      // y up from the rule: one CSS pixel above the canvas bottom.
      ctx.setTransform(dpr, 0, 0, -dpr, 0, (h - 1) * dpr);
      ctx.clearRect(0, -1, w, h);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // The course: hollow shapes like a printed diagram, in the page's own rule colours.
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color('--text-faint');
      ctx.fillStyle = color('--bg-subtle');
      for (const o of course) {
        ctx.beginPath();
        if (o.kind === 'spikes') {
          ctx.moveTo(o.x, 0);
          for (let i = 0; i < 5; i++) ctx.lineTo(o.x + i * 8 + 4, SPIKE_H), ctx.lineTo(o.x + i * 8 + 8, 0);
          ctx.stroke();
          continue;
        }
        if (o.kind === 'crate') ctx.rect(o.x, 0, CRATE.w, CRATE.h);
        if (o.kind === 'bar') ctx.rect(o.x, BAR.bottom, BAR.w, BAR.h);
        if (o.kind === 'ramp') {
          ctx.moveTo(o.x, 0);
          ctx.lineTo(o.x + RAMP.up, RAMP.h);
          ctx.lineTo(o.x + RAMP.up + RAMP.flat, RAMP.h);
          ctx.lineTo(o.x + RAMP.up + RAMP.flat + RAMP.down, 0);
        }
        ctx.fill();
        ctx.stroke();
      }

      // The finish: one Clay pennant, the only accent in the scene.
      const fx = w - FINISH;
      ctx.beginPath();
      ctx.moveTo(fx, 0);
      ctx.lineTo(fx, 22);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(fx, 22);
      ctx.lineTo(fx + 10, 18.5);
      ctx.lineTo(fx, 15);
      ctx.fillStyle = color('--accent');
      ctx.fill();

      // The runners: one every GAP px, so each is at a different obstacle.
      const ink = color('--text-muted');
      ctx.strokeStyle = ink;
      ctx.fillStyle = ink;
      ctx.lineWidth = 2;
      for (const rx of runnersAt(x, w)) {
        const f = figureAt(rx, course);
        const pose = poseFor((rx / STRIDE) * Math.PI * 2, f);
        const at = ([px, py]: Pt): Pt => [rx + px, f.lift + py];
        ctx.beginPath();
        ctx.moveTo(...at(pose.neck));
        ctx.lineTo(...at(pose.hip));
        for (const [a, b, c] of pose.limbs) {
          ctx.moveTo(...at(a));
          ctx.lineTo(...at(b));
          ctx.lineTo(...at(c));
        }
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(...at(pose.head), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      if (reduced) cancelAnimationFrame(raf);
    };

    // rAF already stops in a hidden tab; the dt cap keeps the runner from
    // teleporting when it comes back.
    raf = requestAnimationFrame(draw);
    const onResize = () => {
      if (reduced) {
        last = 0;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(draw);
      }
    };
    addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener('resize', onResize);
    };
  }, []);

  return <canvas ref={ref} className="edition-scene" aria-hidden="true" />;
}
