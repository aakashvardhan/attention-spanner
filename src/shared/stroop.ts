/**
 * Stroop warm-up sprint — trial generation + scoring for the pre-work
 * ritual game. Every trial is incongruent (word ≠ ink) so each answer
 * exercises inhibition, and the ink never repeats the previous trial's
 * so the same button is never correct twice in a row. Pure and
 * rand-injectable for tests.
 */

export const WARMUP_SECONDS = 60;

export const STROOP_COLORS = ['red', 'blue', 'green', 'purple'] as const;
export type StroopColor = (typeof STROOP_COLORS)[number];

export interface StroopTrial {
  /** The color name displayed as text */
  word: StroopColor;
  /** The color the text is rendered in — the correct answer */
  ink: StroopColor;
}

function pick<T>(pool: readonly T[], rand: () => number): T {
  return pool[Math.floor(rand() * pool.length)];
}

export function nextTrial(
  prev: StroopTrial | null,
  rand: () => number = Math.random,
): StroopTrial {
  const inkPool = STROOP_COLORS.filter((c) => c !== prev?.ink);
  const ink = pick(inkPool, rand);
  const wordPool = STROOP_COLORS.filter((c) => c !== ink);
  return { word: pick(wordPool, rand), ink };
}

export interface WarmupResult {
  score: number;
  /** 0–100 integer; 0 when nothing was answered */
  accuracy: number;
}

export function scoreSession(correct: number, wrong: number): WarmupResult {
  const total = correct + wrong;
  return {
    score: correct,
    accuracy: total > 0 ? Math.round((correct / total) * 100) : 0,
  };
}
