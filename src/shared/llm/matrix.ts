import { LAYA_ROLE_MIN } from '../constants';
import { getLocal } from '../storage';
import type { Annotation, HighlightRole, Paper } from '../types';
import { clip, systemOne, type LayaQuestion } from './laya';
import { hashText, updateRoles } from './store';

/**
 * The literature matrix: for each paper, which of your highlights is its
 * claim, its method, its result, its limitation. Laya only sorts — every cell
 * is your own highlighted text, so there is nothing generated to fact-check.
 * Tested on DDPM's own sentences it put four of four in the right column.
 */

const ROLE_QUESTION: LayaQuestion = {
  type: 'choice',
  instructions: 'What role does this highlighted passage play in the paper?',
  criteria: {
    claim: 'a claim or contribution the authors make',
    method: 'how something is done',
    result: 'an experimental finding or number',
    limitation: 'a weakness, caveat or open problem',
    definition: 'defines a term or concept',
    other: 'none of these',
  },
};

export const MATRIX_COLUMNS = ['claim', 'method', 'result', 'limitation'] as const;
export type MatrixColumn = (typeof MATRIX_COLUMNS)[number];

export interface MatrixRow {
  paper: Paper;
  cells: Record<MatrixColumn, Annotation | null>;
}

const roleText = (a: Annotation) => [a.text, a.note].filter(Boolean).join('\n');

/**
 * Roles for the highlights on `papers`, asking Laya only about the ones not
 * already classified from the same text. `annotations` must be all of them:
 * roles for deleted highlights are dropped in the same write. A failed call
 * (the sidecar stopped) keeps what was classified so far.
 */
export async function classifyRoles(
  layaUrl: string,
  annotations: readonly Annotation[],
  papers: readonly Paper[],
  signal?: AbortSignal,
): Promise<Record<string, HighlightRole>> {
  const { layaRoles } = await getLocal('layaRoles');
  const titles = new Map(papers.map((p) => [p.id, p.title]));
  const fresh: Record<string, HighlightRole> = {};
  for (const a of annotations) {
    const title = a.paperId ? titles.get(a.paperId) : undefined;
    const text = roleText(a);
    if (title === undefined || !text.trim()) continue;
    const hash = hashText(text);
    if (layaRoles[a.id]?.hash === hash) continue;
    try {
      const state = { paper: title, highlight: clip(a.text, 1200), note: clip(a.note, 400) };
      const { role } = await systemOne(layaUrl, state, { role: ROLE_QUESTION }, signal);
      if (role?.type === 'choice') fresh[a.id] = { role: role.choice, p: role.probabilities[role.choice] ?? 0, hash };
    } catch {
      break;
    }
  }

  const live = new Set(annotations.map((a) => a.id));
  const keepLive = (roles: Record<string, HighlightRole>) =>
    Object.fromEntries(Object.entries(roles).filter(([id]) => live.has(id)));
  await updateRoles((current) => keepLive({ ...current, ...fresh }));
  return keepLive({ ...layaRoles, ...fresh });
}

/** One row per paper with a highlight; each cell is the surest highlight for that role. */
export function buildMatrix(
  papers: readonly Paper[],
  annotations: readonly Annotation[],
  roles: Record<string, HighlightRole>,
  min = LAYA_ROLE_MIN,
): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const paper of papers) {
    const own = annotations.filter((a) => a.paperId === paper.id && roleText(a).trim());
    if (own.length === 0) continue;
    const cells = {} as MatrixRow['cells'];
    for (const column of MATRIX_COLUMNS) {
      let best: Annotation | null = null;
      for (const a of own) {
        const r = roles[a.id];
        if (r?.role === column && r.p >= min && (!best || r.p > roles[best.id].p)) best = a;
      }
      cells[column] = best;
    }
    rows.push({ paper, cells });
  }
  return rows;
}

const cellText = (a: Annotation | null) =>
  a ? (a.text || a.note).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim() : '';

/** For pasting into a literature-review draft. */
export function matrixMarkdown(rows: readonly MatrixRow[]): string {
  const head = ['Paper', 'Claim', 'Method', 'Result', 'Limitation'];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => ' --- ').join('|')}|`];
  for (const { paper, cells } of rows) {
    const title = `${paper.title}${paper.year ? ` (${paper.year})` : ''}`.replace(/\|/g, '\\|');
    lines.push(`| ${[title, ...MATRIX_COLUMNS.map((c) => cellText(cells[c]))].join(' | ')} |`);
  }
  return lines.join('\n');
}
