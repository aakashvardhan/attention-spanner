import { describe, expect, it } from 'vitest';
import type { Io } from '../args';
import { LIMIT_MS, parseQuestions, runRecall, summarizeRecall } from './recall';

const qs = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}. Question ${i + 1}?`).join('\n');

describe('parseQuestions', () => {
  it('reads exactly 25 numbered questions', () => {
    expect(parseQuestions(`# Mine\n\n${qs(25)}\n`)).toHaveLength(25);
  });
  it('refuses the wrong count or a gap in numbering', () => {
    expect(() => parseQuestions(qs(24))).toThrow(/exactly 25/);
    expect(() => parseQuestions(qs(25).replace('3. Question 3?', '4. Question 3?'))).toThrow(/question 3 is missing/);
  });
});

describe('summarizeRecall', () => {
  it('counts failures as the 60 s limit in the median', () => {
    const rows = [
      { n: 1, ms: 5_000, success: true },
      { n: 2, ms: 1_000, success: false },
      { n: 3, ms: 20_000, success: true },
    ];
    expect(summarizeRecall(rows)).toEqual({ n: 3, successRate: 2 / 3, medianMs: 20_000 });
    expect(summarizeRecall([])).toEqual({ n: 0, successRate: 0, medianMs: null });
  });
});

describe('runRecall', () => {
  function scripted(answers: string[], times: number[]): Io {
    return { ask: async () => answers.shift() ?? '', say: () => {}, now: () => times.shift() ?? 0 };
  }
  it('times each question and asks whether the note was right', async () => {
    const io = scripted(['', '', 'y', '', 'x', '', ''], [0, 4_000, 10, 20, 100, 100 + LIMIT_MS + 1]);
    expect(await runRecall(['a', 'b', 'c'], 'Notion', io)).toEqual([
      { n: 1, ms: 4_000, success: true },
      { n: 2, ms: 10, success: false },
      { n: 3, ms: LIMIT_MS + 1, success: false },
    ]);
  });
});
