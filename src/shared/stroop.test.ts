import { describe, expect, it } from 'vitest';
import { nextTrial, scoreSession, STROOP_COLORS, type StroopTrial } from './stroop';

/** rand stub that returns the given values in order */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[i++] ?? 0;
}

/** deterministic spread over [0, 1) */
function spread(): () => number {
  let i = 0;
  return () => ((i += 7919) % 10_000) / 10_000;
}

describe('nextTrial', () => {
  it('picks ink then word deterministically from the pools', () => {
    // ink pool is all 4 colors (no prev), word pool excludes the ink
    expect(nextTrial(null, seq(0, 0))).toEqual({ ink: 'red', word: 'blue' });
    // last ink, last remaining word
    expect(nextTrial(null, seq(0.99, 0.99))).toEqual({ ink: 'purple', word: 'green' });
  });

  it('is always incongruent', () => {
    const rand = spread();
    for (let n = 0; n < 1000; n++) {
      const trial = nextTrial(null, rand);
      expect(trial.word).not.toBe(trial.ink);
    }
  });

  it('never repeats the previous ink', () => {
    const rand = spread();
    let prev: StroopTrial = nextTrial(null, rand);
    for (let n = 0; n < 1000; n++) {
      const trial = nextTrial(prev, rand);
      expect(trial.ink).not.toBe(prev.ink);
      expect(trial.word).not.toBe(trial.ink);
      prev = trial;
    }
  });

  it('reaches every color as both ink and word', () => {
    const rand = spread();
    const inks = new Set<string>();
    const words = new Set<string>();
    let prev: StroopTrial | null = null;
    for (let n = 0; n < 1000; n++) {
      prev = nextTrial(prev, rand);
      inks.add(prev.ink);
      words.add(prev.word);
    }
    expect(inks.size).toBe(STROOP_COLORS.length);
    expect(words.size).toBe(STROOP_COLORS.length);
  });
});

describe('scoreSession', () => {
  it('returns zero accuracy for an empty session', () => {
    expect(scoreSession(0, 0)).toEqual({ score: 0, accuracy: 0 });
  });

  it('computes accuracy as a rounded percentage', () => {
    expect(scoreSession(10, 0)).toEqual({ score: 10, accuracy: 100 });
    expect(scoreSession(7, 3)).toEqual({ score: 7, accuracy: 70 });
    expect(scoreSession(1, 2)).toEqual({ score: 1, accuracy: 33 });
  });
});
