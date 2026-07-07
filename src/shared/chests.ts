/**
 * Mystery chest roll — variable-ratio bonus XP on completions. Fixed +5 XP
 * goes numb fast; an occasional surprise bonus keeps the reward circuit
 * interested. Pure and rand-injectable for tests; RNG runs only in the
 * service worker.
 */

export const CHEST_DROP_RATE = 0.15;

/** Bonus tiers with cumulative-scan weights (must sum to 1) */
const TIERS: readonly { bonusXp: number; weight: number }[] = [
  { bonusXp: 10, weight: 0.7 },
  { bonusXp: 25, weight: 0.25 },
  { bonusXp: 50, weight: 0.05 },
];

/** Returns the chest's bonus XP, or null when no chest drops */
export function rollChest(rand: () => number = Math.random): number | null {
  if (rand() >= CHEST_DROP_RATE) return null;
  let roll = rand();
  for (const tier of TIERS) {
    if (roll < tier.weight) return tier.bonusXp;
    roll -= tier.weight;
  }
  return TIERS[TIERS.length - 1].bonusXp;
}
