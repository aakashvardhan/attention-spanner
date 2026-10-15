import { describe, expect, it } from 'vitest';
import { mulberry32, parseGroups, stratifiedSample } from './sample';

describe('mulberry32', () => {
  it('is deterministic for a seed and stays in [0, 1)', () => {
    const a = mulberry32(7), b = mulberry32(7);
    const xs = Array.from({ length: 50 }, () => a());
    expect(xs).toEqual(Array.from({ length: 50 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe('stratifiedSample', () => {
  const items = [...Array.from({ length: 30 }, (_, i) => `school-${i}`), ...Array.from({ length: 5 }, (_, i) => `career-${i}`), 'misc-0'];
  const stratum = (s: string) => s.split('-')[0];
  it('draws from every stratum before taking more of any', () => {
    const s = stratifiedSample(items, stratum, 6, 1);
    expect(new Set(s.map(stratum))).toEqual(new Set(['school', 'career', 'misc']));
    expect(s).toHaveLength(6);
  });
  it('is reproducible and never repeats an item', () => {
    const s = stratifiedSample(items, stratum, 20, 3);
    expect(s).toEqual(stratifiedSample(items, stratum, 20, 3));
    expect(new Set(s).size).toBe(20);
  });
  it('returns everything when n exceeds the pool', () => {
    expect(stratifiedSample(items, stratum, 100, 1)).toHaveLength(items.length);
  });
});

describe('parseGroups', () => {
  const expected = ['Sigmoid', 'Lecture 3', 'Resume'];
  it('reads groups under ## headings', () => {
    expect(parseGroups('# Card sort\n\nintro\n\n## Class\n- Sigmoid\n- Lecture 3\n\n## Jobs\n- Resume\n', expected)).toEqual([
      { name: 'Class', cards: ['Sigmoid', 'Lecture 3'] },
      { name: 'Jobs', cards: ['Resume'] },
    ]);
  });
  it('lists every ungrouped, missing, duplicated or unknown card', () => {
    expect(() => parseGroups('- Sigmoid\n## A\n- Lecture 3\n- Lecture 3\n- Stranger\n', expected)).toThrow(
      /not in a group: Sigmoid[\s\S]*more than once: Lecture 3[\s\S]*not in the sample: Stranger[\s\S]*missing: Resume/,
    );
  });
});
