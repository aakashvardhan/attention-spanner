/**
 * Variable-ratio drop on completions. A fixed reward goes numb fast; an
 * occasional surprise keeps the reward circuit interested.
 *
 * The drop used to pay bonus XP, which meant a second currency ran alongside
 * streaks. It now banks a streak freeze token — the one currency the app still
 * shows — so the surprise protects the thing the user cares about instead of
 * inflating a number nobody reads. Pure and rand-injectable for tests; RNG
 * runs only in the service worker.
 */

export const CHEST_DROP_RATE = 0.15;

/** Does this completion bank a freeze token? */
export function rollFreeze(rand: () => number = Math.random): boolean {
  return rand() < CHEST_DROP_RATE;
}
