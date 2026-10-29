import { describe, expect, it } from 'vitest';
import {
  NO_ANSWER_RULE,
  breakdownRequest,
  counterpointRequest,
  equationRequest,
  lockRequest,
  parseBreakdown,
  parseCounterpoint,
  socraticSystem,
} from './provoke';

const source = 'arxiv' as const;

describe('provoke', () => {
  it('every request ends with NO_ANSWER_RULE and uses task provoke', () => {
    const reqs = [
      equationRequest({ key: 'k', page: 1, block: 'a=b', source }),
      lockRequest({ key: 'k', page: 1, pageText: 'p', doubts: ['d'], source }),
    ];
    for (const r of reqs) {
      expect(r.task).toBe('provoke');
      expect(r.cacheKey).toBeTruthy();
    }
    expect(reqs[0].system).toContain(NO_ANSWER_RULE);
    expect(socraticSystem().endsWith(NO_ANSWER_RULE)).toBe(true);
    const bd = breakdownRequest({ key: 'k', page: 1, block: 'a=b', guess: 'g', source });
    const cp = counterpointRequest({ key: 'k', passage: 'p', reasoning: 'r', source });
    expect([bd.task, cp.task]).toEqual(['provoke', 'provoke']);
    expect(cp.system).toContain('reasoning');
    for (const r of [reqs[0], reqs[1], bd]) expect(r.system).not.toContain('reasoning');
  });

  it('parseCounterpoint reads Q/Gap, null for NONE', () => {
    expect(parseCounterpoint('Q: Could age explain it?\nGap: confounder')).toEqual({
      question: 'Could age explain it?',
      gap: 'confounder',
    });
    expect(parseCounterpoint('NONE')).toBeNull();
  });

  it('parseBreakdown reads 1./2./3.', () => {
    expect(parseBreakdown('1. a?\n2. b?\n3. c?')).toEqual(['a?', 'b?', 'c?']);
    expect(parseBreakdown('nonsense')).toEqual([]);
  });
});
