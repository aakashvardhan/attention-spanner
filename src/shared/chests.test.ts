import { describe, expect, it } from 'vitest';
import { CHEST_DROP_RATE, rollChest } from './chests';

/** rand stub that returns the given values in order */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[i++] ?? 0;
}

describe('rollChest', () => {
  it('returns null when the drop roll misses', () => {
    expect(rollChest(seq(CHEST_DROP_RATE))).toBeNull();
    expect(rollChest(seq(0.99))).toBeNull();
  });

  it('drops the common tier for low tier-rolls', () => {
    expect(rollChest(seq(0, 0))).toBe(10);
    expect(rollChest(seq(0.1, 0.69))).toBe(10);
  });

  it('drops the mid tier between 0.7 and 0.95', () => {
    expect(rollChest(seq(0.1, 0.7))).toBe(25);
    expect(rollChest(seq(0.1, 0.94))).toBe(25);
  });

  it('drops the rare tier above 0.95 (and as the fallback)', () => {
    expect(rollChest(seq(0.1, 0.95))).toBe(50);
    expect(rollChest(seq(0.1, 0.999))).toBe(50);
  });

  it('honors the drop rate distribution roughly', () => {
    let i = 0;
    const rand = () => ((i += 7919) % 10_000) / 10_000; // deterministic spread
    let drops = 0;
    for (let n = 0; n < 10_000; n++) if (rollChest(rand) !== null) drops++;
    expect(drops / 10_000).toBeGreaterThan(0.1);
    expect(drops / 10_000).toBeLessThan(0.2);
  });
});
