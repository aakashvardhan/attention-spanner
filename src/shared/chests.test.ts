import { describe, expect, it } from 'vitest';
import { CHEST_DROP_RATE, rollFreeze } from './chests';

describe('rollFreeze', () => {
  it('drops below the rate and misses at or above it', () => {
    expect(rollFreeze(() => 0)).toBe(true);
    expect(rollFreeze(() => CHEST_DROP_RATE - 0.001)).toBe(true);
    expect(rollFreeze(() => CHEST_DROP_RATE)).toBe(false);
    expect(rollFreeze(() => 0.99)).toBe(false);
  });

  it('honors the drop rate distribution roughly', () => {
    let i = 0;
    const rand = () => ((i += 7919) % 10_000) / 10_000; // deterministic spread
    let drops = 0;
    for (let n = 0; n < 10_000; n++) if (rollFreeze(rand)) drops++;
    expect(drops / 10_000).toBeGreaterThan(0.1);
    expect(drops / 10_000).toBeLessThan(0.2);
  });
});
