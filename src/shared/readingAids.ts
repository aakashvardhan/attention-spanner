/*
 * The reader's anti-drift aids as pure decisions: how long is left, whether a
 * section was just finished, and whether attention has wandered. Components
 * only feed in events and render what comes back.
 */

const WORDS_PER_MINUTE = 230;

export function wordCounts(passages: readonly string[]): number[] {
  return passages.map((p) => p.split(/\s+/).filter(Boolean).length);
}

/** Minutes to the end from passage `index` (0-based), `fraction` of the way through it. */
export function minutesLeft(counts: readonly number[] | null, index: number, fraction: number): number | null {
  if (!counts) return null;
  if (index >= counts.length) return 0;
  let words = counts[index] * (1 - Math.min(1, Math.max(0, fraction)));
  for (let i = index + 1; i < counts.length; i++) words += counts[i];
  return Math.ceil(words / WORDS_PER_MINUTE);
}

export function timeLeftLabel(minutes: number | null): string {
  if (minutes === null) return '';
  return minutes === 0 ? 'almost done' : `about ${minutes} min left`;
}

/** Reading forward into the next section finishes the previous one; jumps do not count. */
export function crossedSection(prev: number, next: number): number | null {
  return prev >= 0 && next === prev + 1 ? prev : null;
}

export function sectionDoneLabel(finished: number, total: number): string {
  const left = total - finished - 1;
  return left <= 0 ? 'Last section done' : `Section ${finished + 1} done · ${left} left`;
}

export const DRIFT_IDLE_MS = 180_000;
export const DRIFT_AWAY_MS = 120_000;

export type DriftEvent = { type: 'activity' | 'hidden' | 'visible' | 'tick'; at: number };

export interface DriftState {
  lastActivity: number;
  hiddenAt: number | null;
  /** Set when a nudge fires; cleared by activity, so it fires once per drift. */
  nudged: boolean;
}

export function driftStep(state: DriftState, event: DriftEvent): { state: DriftState; nudge: boolean } {
  switch (event.type) {
    case 'activity':
      return { state: { ...state, lastActivity: event.at, nudged: false }, nudge: false };
    case 'hidden':
      return { state: { ...state, hiddenAt: event.at }, nudge: false };
    case 'visible': {
      const away = state.hiddenAt !== null && event.at - state.hiddenAt > DRIFT_AWAY_MS;
      const nudge = away && !state.nudged;
      return { state: { lastActivity: event.at, hiddenAt: null, nudged: state.nudged || nudge }, nudge };
    }
    case 'tick': {
      const nudge = state.hiddenAt === null && !state.nudged && event.at - state.lastActivity >= DRIFT_IDLE_MS;
      return { state: nudge ? { ...state, nudged: true } : state, nudge };
    }
  }
}
