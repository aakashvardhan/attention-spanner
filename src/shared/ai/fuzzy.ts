/**
 * Tiny dependency-free fuzzy scorer for the command palette.
 * 0 = no match; higher is better. Pure, unit-tested.
 */

export function fuzzyScore(query: string, target: string): number {
  const q = query.trim().toLowerCase();
  const t = target.trim().toLowerCase();
  if (!q || !t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 90;
  if (t.includes(q)) return 70;

  // All query chars appear in order (e.g. "sfs" → "Start focus session")
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i += 1;
    if (i === q.length) return 40;
  }
  return 0;
}

/** Score a palette command by its label and keywords (keywords count less) */
export function scoreCommand(query: string, label: string, keywords: string[]): number {
  let best = fuzzyScore(query, label);
  for (const keyword of keywords) {
    best = Math.max(best, Math.min(65, fuzzyScore(query, keyword)));
  }
  return best;
}
