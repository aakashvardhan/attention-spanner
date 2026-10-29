import type { Annotation, AnnotationColor, HighlightTag, Provocation } from './types';

export const XP = { resolve: 10, revise: 15, defend: 15, verdict: 20 } as const;
export const TAG_COLOR: Record<HighlightTag, AnnotationColor> = { claim: 'blue', evidence: 'green', doubt: 'pink' };

const isOpen = (p: Provocation) => p.status !== 'answered';

/** prev null = new record. 0 when prev.xp > 0. */
export function xpAward(prev: Provocation | null, next: Provocation): number {
  if (prev && prev.xp > 0) return 0;
  if (next.status !== 'answered') return 0;
  if (next.kind === 'counterpoint') {
    if (next.response === 'revised') return XP.revise;
    if (next.response === 'defended' && next.citedPage != null) return XP.defend;
    return 0;
  }
  if (next.kind === 'verdict') return prev ? 0 : XP.verdict;
  return prev && isOpen(prev) ? XP.resolve : 0;
}

export interface ThinkingItem { id: string; text: string; page: number; note: string }
export interface PaperThinking { claims: ThinkingItem[]; doubts: ThinkingItem[]; open: ThinkingItem[]; xp: number }

const byPage = (a: ThinkingItem, b: ThinkingItem) => a.page - b.page;
const pageOf = (a: Annotation) => (a.anchor.kind === 'pdf' ? a.anchor.page : 0);

export function paperThinking(
  paperId: string,
  annotations: readonly Annotation[],
  provocations: readonly Provocation[],
): PaperThinking {
  const alive = new Set(annotations.map((a) => a.id));
  const mine = provocations.filter((p) => p.paperId === paperId && (p.annotationId == null || alive.has(p.annotationId)));
  const tagged = (tag: HighlightTag): ThinkingItem[] =>
    annotations
      .filter((a) => a.paperId === paperId && a.tag === tag)
      .map((a) => ({ id: a.id, text: a.text, page: pageOf(a), note: a.note }));
  const item = (p: Provocation, note: string): ThinkingItem => ({ id: p.id, text: p.question, page: p.page, note });
  const answered = mine.filter((p) => p.status === 'answered');

  const claims = [...tagged('claim'), ...answered.filter((p) => p.kind === 'page').map((p) => item(p, p.answer))];
  const doubts = [
    ...tagged('doubt'),
    ...answered.flatMap((p) =>
      p.kind === 'counterpoint'
        ? [item(p, p.response === 'revised' ? 'you revised' : 'you held your position')]
        : p.kind === 'lock'
          ? [item(p, 'you justified this to unlock pass 3')]
          : [],
    ),
  ];
  const open = mine.filter((p) => isOpen(p) && p.kind !== 'page').map((p) => item(p, p.answer));
  return {
    claims: claims.sort(byPage),
    doubts: doubts.sort(byPage),
    open: open.sort(byPage),
    xp: mine.reduce((n, p) => n + p.xp, 0),
  };
}

const RANK: Record<string, number> = { lock: 0, equation: 1 };

/** An open/unsure record from these papers, stable for a local day; doubts' counterpoints first. */
export function todaysQuestion(
  paperIds: readonly string[],
  provocations: readonly Provocation[],
  dayKey: string,
): Provocation | null {
  const c = provocations
    .filter((p) => p.paperId != null && paperIds.includes(p.paperId) && isOpen(p))
    .sort((a, b) => (RANK[a.kind] ?? 2) - (RANK[b.kind] ?? 2) || a.createdAt - b.createdAt);
  if (!c.length) return null;
  let h = 0;
  for (const ch of dayKey) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return c[h % c.length];
}
