import { describe, expect, it } from 'vitest';
import type { Annotation, Provocation } from './types';
import { paperThinking, todaysQuestion, xpAward } from './thinking';

const prov = (o: Partial<Provocation> = {}): Provocation => ({
  id: 'p1', docKey: 'd', paperId: 'a', page: 1, kind: 'page', question: 'q', answer: '',
  status: 'open', annotationId: null, xp: 0, createdAt: 1, updatedAt: 1, ...o,
});
const ann = (id: string, page: number, tag?: Annotation['tag'], note = ''): Annotation => ({
  id, tag, docKey: 'd', docUrl: 'u', paperId: 'a', kind: 'highlight',
  anchor: { kind: 'pdf', page, rects: [], x: 0, y: 0 }, text: `t${id}`, color: 'yellow',
  note, createdAt: 1, updatedAt: 1,
} as Annotation);

describe('xpAward', () => {
  it('open→answered gives 10', () => {
    expect(xpAward(prov(), prov({ status: 'answered' }))).toBe(10);
    expect(xpAward(prov({ status: 'unsure' }), prov({ status: 'answered' }))).toBe(10);
  });
  it('already-awarded gives 0', () => {
    expect(xpAward(prov({ xp: 10 }), prov({ status: 'answered' }))).toBe(0);
  });
  it('born-answered page record gives 0', () => {
    expect(xpAward(null, prov({ status: 'answered' }))).toBe(0);
  });
  it('revised 15, defended with page 15, defended without page 0', () => {
    const cp = { kind: 'counterpoint', status: 'answered' } as const;
    expect(xpAward(null, prov({ ...cp, response: 'revised' }))).toBe(15);
    expect(xpAward(null, prov({ ...cp, response: 'defended', citedPage: 3 }))).toBe(15);
    expect(xpAward(null, prov({ ...cp, response: 'defended' }))).toBe(0);
  });
  it('new verdict 20', () => {
    expect(xpAward(null, prov({ kind: 'verdict', status: 'answered' }))).toBe(20);
  });
});

describe('paperThinking', () => {
  it('columns sort tagged highlights and answered records by page', () => {
    const anns = [ann('a', 5, 'claim', 'why'), ann('b', 2, 'claim'), ann('c', 4, 'doubt'), ann('e', 1, 'evidence')];
    const t = paperThinking('a', anns, [
      prov({ id: '1', page: 3, status: 'answered', answer: 'mine', xp: 10 }),
      prov({ id: '2', page: 1, kind: 'counterpoint', status: 'answered', annotationId: 'c', response: 'revised', xp: 15 }),
      prov({ id: '3', page: 6, kind: 'lock', status: 'answered', xp: 10 }),
      prov({ id: '4', paperId: 'other', status: 'answered', xp: 10 }),
    ]);
    expect(t.claims.map((i) => i.page)).toEqual([2, 3, 5]);
    expect(t.claims[2].note).toBe('why');
    expect(t.doubts.map((i) => i.page)).toEqual([1, 4, 6]);
    expect(t.doubts[0].note).toBe('you revised');
    expect(t.doubts[2].note).toBe('you justified this to unlock pass 3');
    expect(t.xp).toBe(35);
  });
  it('open excludes page records, includes unsure', () => {
    const t = paperThinking('a', [], [
      prov({ id: '1', kind: 'page' }),
      prov({ id: '2', kind: 'equation', page: 2 }),
      prov({ id: '3', kind: 'lock', status: 'unsure', page: 1 }),
    ]);
    expect(t.open.map((i) => i.id)).toEqual(['3', '2']);
  });
  it('drops counterpoints on deleted highlights', () => {
    const t = paperThinking('a', [ann('c', 1, 'doubt')], [
      prov({ id: '1', kind: 'counterpoint', status: 'answered', annotationId: 'gone', response: 'revised' }),
      prov({ id: '2', kind: 'counterpoint', status: 'answered', annotationId: 'c', response: 'defended', citedPage: 1 }),
    ]);
    expect(t.doubts.map((i) => i.note)).toEqual(['', 'you held your position']);
  });
});

describe('todaysQuestion', () => {
  const ps = [
    prov({ id: 'x', createdAt: 3 }), prov({ id: 'y', kind: 'equation', createdAt: 2 }),
    prov({ id: 'z', kind: 'lock', createdAt: 9, status: 'unsure' }),
    prov({ id: 'done', status: 'answered' }), prov({ id: 'foreign', paperId: 'b' }),
  ];
  it("today's question is stable within a day, rotates across days, null when nothing is open", () => {
    expect(todaysQuestion(['a'], ps, '2026-10-29')).toEqual(todaysQuestion(['a'], ps, '2026-10-29'));
    const picks = new Set<string>();
    for (let d = 1; d <= 30; d++) {
      const q = todaysQuestion(['a'], ps, `2026-10-${d}`);
      expect(['x', 'y', 'z']).toContain(q!.id);
      picks.add(q!.id);
    }
    expect(picks.size).toBeGreaterThan(1);
    expect(todaysQuestion(['a'], [prov({ status: 'answered' })], 'k')).toBeNull();
    expect(todaysQuestion([], ps, 'k')).toBeNull();
  });
  it('doubts first: kind outranks createdAt in the ordering', () => {
    const mk = (eAt: number, lAt: number) => [
      prov({ id: 'e', kind: 'equation', createdAt: eAt }), prov({ id: 'l', kind: 'lock', createdAt: lAt }),
    ];
    for (let d = 1; d <= 20; d++) {
      const a = todaysQuestion(['a'], mk(1, 2), `d${d}`)!.id;
      expect(todaysQuestion(['a'], mk(2, 1), `d${d}`)!.id).toBe(a);
    }
  });
});
