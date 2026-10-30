import { readerPageUrl } from './pdf';
import type { Annotation, AnnotationColor, HighlightTag, Paper, Provocation } from './types';

export const XP = { resolve: 10, revise: 15, defend: 15, verdict: 20 } as const;
export const TAG_COLOR: Record<HighlightTag, AnnotationColor> = { claim: 'blue', evidence: 'green', doubt: 'pink' };

const isOpen = (p: Provocation) => p.status !== 'answered';
/** A counterpoint whose highlight was deleted is dead; everything else is live. */
const isLive = (p: Provocation, alive: ReadonlySet<string>) => p.annotationId == null || alive.has(p.annotationId);
const isOpenQuestion = (p: Provocation): p is Provocation & { status: 'open' | 'unsure' } => isOpen(p) && p.kind !== 'page';

/** Reader link for a paper, deep-linked to a page when page > 0. */
export const thinkingLink = (paper: Paper, page: number) => {
  const base = readerPageUrl(paper.pdf?.url ?? paper.url);
  return page > 0 ? `${base}#page=${page}` : base;
};

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
  const mine = provocations.filter((p) => p.paperId === paperId && isLive(p, alive));
  const tagged = (tag: HighlightTag): ThinkingItem[] =>
    annotations
      .filter((a) => a.paperId === paperId && a.tag === tag)
      .map((a) => ({ id: a.id, text: a.text, page: pageOf(a), note: a.note }));
  const item = (p: Provocation, note: string, text = p.answer): ThinkingItem => ({ id: p.id, text, page: p.page, note });
  const answered = mine.filter((p) => p.status === 'answered');

  const claims = [...tagged('claim'), ...answered.filter((p) => p.kind === 'page').map((p) => item(p, p.question))];
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
  const open = mine.filter(isOpenQuestion).map((p) => item(p, p.answer, p.question));
  return {
    claims: claims.sort(byPage),
    doubts: doubts.sort(byPage),
    open: open.sort(byPage),
    xp: mine.reduce((n, p) => n + p.xp, 0),
  };
}

export interface OpenQuestion {
  id: string; question: string; status: 'open' | 'unsure'; paperTitle: string; href: string; updatedAt: number;
}

/** Every open question across papers, newest first; same rule as paperThinking().open. */
export function openQuestions(
  papers: readonly Paper[],
  annotations: readonly Annotation[],
  provocations: readonly Provocation[],
): OpenQuestion[] {
  const alive = new Set(annotations.map((a) => a.id));
  const byId = new Map(papers.map((p) => [p.id, p]));
  return provocations
    .flatMap((p) => {
      const paper = p.paperId == null ? undefined : byId.get(p.paperId);
      if (!paper || !isOpenQuestion(p) || !isLive(p, alive)) return [];
      return [{ id: p.id, question: p.question, status: p.status, paperTitle: paper.title, href: thinkingLink(paper, p.page), updatedAt: p.updatedAt }];
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

const RANK: Record<string, number> = { lock: 0, equation: 1 };

/** An open/unsure record from these papers, stable for a local day; ordered lock, equation, then others, each by createdAt. */
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
