import { describe, expect, it } from 'vitest';
import type { Annotation, Paper } from '../types';
import { buildMatrix, matrixMarkdown } from './matrix';

const paper = (id: string, title: string) => ({ id, title, year: 2020 }) as Paper;
const hl = (id: string, paperId: string, text: string) => ({ id, paperId, text, note: '' }) as Annotation;
const role = (r: string, p: number) => ({ role: r, p, hash: 'h' });

describe('buildMatrix', () => {
  const papers = [paper('p1', 'DDPM'), paper('p2', 'Unread')];
  const annotations = [
    hl('a1', 'p1', 'FID 3.17 on CIFAR10'),
    hl('a2', 'p1', 'FID 3.75 with fewer steps'),
    hl('a3', 'p1', 'Log likelihoods are not competitive'),
    hl('a4', 'p1', 'Trained on a weighted variational bound'),
  ];
  const roles = {
    a1: role('result', 0.98),
    a2: role('result', 0.7),
    a3: role('limitation', 0.97),
    a4: role('method', 0.4),
  };

  it('fills each column with the surest highlight and leaves unsure ones out', () => {
    const [row] = buildMatrix(papers, annotations, roles, 0.5);
    expect(row.cells.result?.id).toBe('a1');
    expect(row.cells.limitation?.id).toBe('a3');
    expect(row.cells.method).toBeNull();
    expect(row.cells.claim).toBeNull();
  });

  it('skips papers with no highlights', () => {
    expect(buildMatrix(papers, annotations, roles, 0.5).map((r) => r.paper.id)).toEqual(['p1']);
  });
});

describe('matrixMarkdown', () => {
  it('writes a table and escapes what would break it', () => {
    const rows = buildMatrix([paper('p1', 'A | B')], [hl('a1', 'p1', 'x |\ny')], { a1: role('result', 0.9) });
    expect(matrixMarkdown(rows).split('\n')).toEqual([
      '| Paper | Claim | Method | Result | Limitation |',
      '| --- | --- | --- | --- | --- |',
      '| A \\| B (2020) |  |  | x \\| y |  |',
    ]);
  });
});
