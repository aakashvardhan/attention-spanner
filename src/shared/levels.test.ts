import { describe, expect, it } from 'vitest';
import { levelForXp, xpForLevel } from './levels';

describe('xpForLevel', () => {
  it('matches the documented thresholds', () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(100);
    expect(xpForLevel(3)).toBe(300);
    expect(xpForLevel(5)).toBe(1000);
    expect(xpForLevel(10)).toBe(4500);
  });
});

describe('levelForXp', () => {
  it('assigns levels at exact boundaries', () => {
    expect(levelForXp(0).level).toBe(1);
    expect(levelForXp(99).level).toBe(1);
    expect(levelForXp(100).level).toBe(2);
    expect(levelForXp(299).level).toBe(2);
    expect(levelForXp(300).level).toBe(3);
    expect(levelForXp(1000).level).toBe(5);
    expect(levelForXp(4500).level).toBe(10);
  });

  it('keeps intoLevel + remaining consistent with toNext', () => {
    for (const xp of [0, 50, 100, 250, 999, 1000, 4499, 5000]) {
      const { level, intoLevel, toNext } = levelForXp(xp);
      expect(intoLevel).toBeGreaterThanOrEqual(0);
      expect(intoLevel).toBeLessThan(toNext);
      expect(xpForLevel(level) + intoLevel).toBe(xp);
      expect(xpForLevel(level + 1) - xpForLevel(level)).toBe(toNext);
    }
  });

  it('is monotonic', () => {
    let last = 1;
    for (let xp = 0; xp <= 5000; xp += 100) {
      const { level } = levelForXp(xp);
      expect(level).toBeGreaterThanOrEqual(last);
      last = level;
    }
  });
});
