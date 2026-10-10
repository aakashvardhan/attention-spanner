import { describe, expect, it } from 'vitest';
import { BAR, courseFor, figureAt, poseFor, runnersAt, solidAt } from './ObstacleCourse';

// Every drawn point of the runner, in course coordinates, for each x along it.
function* runner(width: number) {
  const course = courseFor(width);
  for (let x = -20; x <= width + 20; x += 0.25) {
    const f = figureAt(x, course);
    const pose = poseFor((x / 22) * Math.PI * 2, f);
    const feet = pose.limbs.slice(0, 2).map(([, , foot]) => foot);
    yield { course, x, f, pose, feet };
  }
}

describe('ObstacleCourse', () => {
  it('lays every obstacle before the flag, at any width', () => {
    expect(courseFor(300)).toHaveLength(1);
    for (const w of [320, 800, 1440, 2560]) {
      const course = courseFor(w);
      expect(course.length).toBeGreaterThan(0);
      expect(Math.max(...course.map((o) => o.x + 100))).toBeLessThanOrEqual(w - 40);
    }
  });

  it('never puts a foot inside the spikes, the crate or the ramp', () => {
    for (const { course, x, f, feet } of runner(1440)) {
      for (const [fx, fy] of feet) {
        // 2px of slack for a planted foot ahead of the hip on the ramp's slope.
        expect(f.lift + fy, `foot at ${x + fx} when runner at ${x}`).toBeGreaterThanOrEqual(
          solidAt(x + fx, course) - 2,
        );
      }
    }
  });

  it('keeps the head under the low bar', () => {
    for (const { course, x, f, pose } of runner(1440)) {
      for (const o of course.filter((c) => c.kind === 'bar')) {
        const [hx, hy] = pose.head;
        if (x + hx + 2.5 >= o.x && x + hx - 2.5 <= o.x + BAR.w) {
          expect(f.lift + hy + 2.5, `head at ${x + hx}`).toBeLessThanOrEqual(BAR.bottom);
        }
      }
    }
  });

  it('crawls only near the bar and runs upright everywhere else', () => {
    const course = courseFor(1440);
    const bar = course.find((o) => o.kind === 'bar')!;
    expect(figureAt(bar.x + 25, course).crouch).toBe(1);
    expect(figureAt(bar.x - 40, course).crouch).toBe(0);
    expect(figureAt(bar.x + 80, course).crouch).toBe(0);
  });

  it('spreads the group evenly over the loop and keeps it on screen', () => {
    expect(runnersAt(0, 375)).toHaveLength(3);
    for (const w of [375, 1280, 2560]) {
      for (const lead of [0, 137.5, 5000, 123456.75]) {
        const xs = runnersAt(lead, w).sort((a, b) => a - b);
        for (const x of xs) {
          expect(x).toBeGreaterThanOrEqual(-20);
          expect(x).toBeLessThan(w + 20);
        }
        // Even gaps, counting the wrap from the last runner back to the first.
        const gaps = xs.map((x, i) => (i ? x - xs[i - 1] : x + w + 40 - xs[xs.length - 1]));
        for (const g of gaps) expect(g).toBeCloseTo((w + 40) / xs.length, 6);
      }
    }
  });
});
