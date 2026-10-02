import { describe, expect, it } from 'vitest';
import { LOCAL_CONTEXT_CHARS } from '../constants';
import { readSoFar, recapRequest, wantsRecap } from './recap';

const passages = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

describe('readSoFar', () => {
  it('stops at the furthest point read, never past it', () => {
    expect(readSoFar(passages, 0.3)).toEqual(['one', 'two', 'three']);
    expect(readSoFar(passages, 0.35)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('always includes at least the first passage', () => {
    expect(readSoFar(passages, 0)).toEqual(['one']);
  });

  it('clamps a fraction past the end', () => {
    expect(readSoFar(passages, 1.4)).toHaveLength(10);
  });

  it('keeps the most recent stretch when the read part is too long', () => {
    const big = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(LOCAL_CONTEXT_CHARS / 4));
    const kept = readSoFar(big, 1);
    expect(kept.length).toBe(4);
    expect(kept.at(-1)).toBe(big[9]);
    expect(kept.join('').length).toBeLessThanOrEqual(LOCAL_CONTEXT_CHARS);
  });

  it('cuts one enormous latest passage to its end instead of dropping it', () => {
    const huge = 'x'.repeat(LOCAL_CONTEXT_CHARS * 2);
    expect(readSoFar(['a', huge], 1)).toEqual(['x'.repeat(LOCAL_CONTEXT_CHARS)]);
  });

  it('skips empty pages, which scanned PDFs produce', () => {
    expect(readSoFar(['intro', '', '  ', 'method'], 1)).toEqual(['intro', 'method']);
  });
});

describe('wantsRecap', () => {
  it('only for a document started in earnest and not essentially done', () => {
    expect(wantsRecap(0)).toBe(false);
    expect(wantsRecap(4)).toBe(false);
    expect(wantsRecap(5)).toBe(true);
    expect(wantsRecap(94)).toBe(true);
    expect(wantsRecap(95)).toBe(false);
  });
});

describe('recapRequest', () => {
  it('shares one cache entry across a ten-point band of progress', () => {
    const at = (percent: number) =>
      recapRequest({ key: 'k', passages, percent, source: 'web' }).cacheKey;
    expect(at(41)).toBe(at(47));
    expect(at(41)).not.toBe(at(51));
  });
});
