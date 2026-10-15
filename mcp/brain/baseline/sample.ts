/** Seeded so a sample can be drawn again exactly, by anyone, without Claude choosing it. */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Round-robin over shuffled strata, so small areas of the workspace are not drowned by large ones. */
export function stratifiedSample<T>(items: T[], stratum: (x: T) => string, n: number, seed: number): T[] {
  const rand = mulberry32(seed);
  const groups = new Map<string, T[]>();
  for (const x of items) {
    const k = stratum(x);
    const g = groups.get(k) ?? [];
    g.push(x);
    groups.set(k, g);
  }
  const queues = shuffle([...groups.keys()].sort(), rand).map((k) => shuffle(groups.get(k)!, rand));
  const out: T[] = [];
  while (out.length < n && queues.some((q) => q.length)) for (const q of queues) if (q.length && out.length < n) out.push(q.shift()!);
  return shuffle(out, rand);
}

/** The sorted card file: "## Group" headings with "- card" lines. Every sampled card exactly once. */
export function parseGroups(md: string, expected: string[]): { name: string; cards: string[] }[] {
  const groups: { name: string; cards: string[] }[] = [];
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const line of md.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      groups.push({ name: h[1], cards: [] });
      continue;
    }
    const c = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!c) continue;
    if (!groups.length) problems.push(`not in a group: ${c[1]}`);
    else groups[groups.length - 1].cards.push(c[1]);
    seen.set(c[1], (seen.get(c[1]) ?? 0) + 1);
  }
  for (const [card, k] of seen) if (k > 1) problems.push(`more than once: ${card}`);
  const known = new Set(expected);
  for (const card of seen.keys()) if (!known.has(card)) problems.push(`not in the sample: ${card}`);
  for (const card of expected) if (!seen.has(card)) problems.push(`missing: ${card}`);
  if (problems.length) throw new Error(`The card sort is not finished:\n${problems.join('\n')}`);
  return groups.filter((g) => g.cards.length);
}
