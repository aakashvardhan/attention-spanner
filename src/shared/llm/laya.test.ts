import { describe, expect, it } from 'vitest';
import { clip, confident } from './laya';

describe('confident', () => {
  it('returns a choice only when its own probability clears the bar', () => {
    const answer = { type: 'choice' as const, choice: 'billing', probabilities: { billing: 0.94, support: 0.06 } };
    expect(confident(answer, 0.8)).toBe('billing');
    expect(confident(answer, 0.95)).toBeNull();
  });

  it('reads a noul both ways and abstains in the middle', () => {
    expect(confident({ type: 'noul', noul: 0.9 }, 0.85)).toBe(true);
    expect(confident({ type: 'noul', noul: 0.1 }, 0.85)).toBe(false);
    expect(confident({ type: 'noul', noul: 0.5 }, 0.85)).toBeNull();
  });

  it('gives the most likely score level as a number, keyed the way Laya keys it', () => {
    const answer = { type: 'score' as const, score: 2.7, probabilities: { '0': 0.02, '1': 0.03, '2': 0.1, '3': 0.85 } };
    expect(confident(answer, 0.8)).toBe(3);
    expect(confident({ ...answer, probabilities: { '0': 0.5, '1': 0.5 } }, 0.8)).toBeNull();
  });

  it('treats a missing answer as no answer', () => {
    expect(confident(undefined, 0.5)).toBeNull();
  });
});

describe('clip', () => {
  it('leaves short text alone', () => {
    expect(clip('short', 100)).toBe('short');
  });

  it('cuts at a word near the limit and marks the cut', () => {
    expect(clip('alpha beta gamma delta', 18)).toBe('alpha beta gamma…');
  });
});
