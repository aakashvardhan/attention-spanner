import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * The spring tokens in theme.css are SwiftUI springs (response,
 * dampingFraction) sampled into CSS linear() curves. This solves each spring
 * and checks the tokens still match. To retune one, change its row here, run
 * this file, and paste the expected value from the failure into theme.css.
 */
const SPRINGS = [
  { name: 'smooth', response: 0.35, damping: 1 },
  { name: 'snappy', response: 0.3, damping: 0.85 },
  { name: 'bouncy', response: 0.4, damping: 0.7 },
] as const;

/** Where a spring released from 0 toward 1, at rest, is after t seconds. */
function springAt(t: number, response: number, damping: number): number {
  const w = (2 * Math.PI) / response;
  if (damping >= 1) return 1 - Math.exp(-w * t) * (1 + w * t);
  const wd = w * Math.sqrt(1 - damping * damping);
  return 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t));
}

/** The spring as a linear() easing, over the time it takes to settle within 0.1%. */
function springCurve(response: number, damping: number): { easing: string; durationMs: number; peak: number } {
  let last = 0;
  for (let ms = 0; ms <= 3000; ms++) {
    if (Math.abs(1 - springAt(ms / 1000, response, damping)) >= 0.001) last = ms;
  }
  const durationMs = Math.ceil(last / 10) * 10;
  const points = Array.from({ length: 33 }, (_, i) =>
    i === 32 ? 1 : Number(springAt((durationMs * i) / 32 / 1000, response, damping).toFixed(3)),
  );
  return { easing: `linear(${points.join(', ')})`, durationMs, peak: Math.max(...points) };
}

const theme = readFileSync(join(__dirname, 'theme.css'), 'utf8');
const token = (name: string) => theme.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();

describe('spring tokens', () => {
  for (const s of SPRINGS) {
    it(`--spring-${s.name} is the solved spring`, () => {
      const { easing, durationMs } = springCurve(s.response, s.damping);
      expect(token(`--spring-${s.name}`)).toBe(easing);
      expect(token(`--dur-${s.name}`)).toBe(`${durationMs}ms`);
    });
  }

  it('smooth never overshoots and bouncy visibly does', () => {
    expect(springCurve(0.35, 1).peak).toBeLessThanOrEqual(1);
    expect(springCurve(0.4, 0.7).peak).toBeGreaterThan(1.02);
  });
});
