import { describe, expect, it } from 'vitest';
import { buildEntry } from './entry';
import { parseQuery } from './query';
import { search, toSearchDoc } from './search';
import { budgetMs, PERF_TIMEOUT } from './testing';

const docs = [
  buildEntry('Concepts/Sigmoid.md', '---\ntags: [concept, ml/basics]\n---\n# Sigmoid\n\n## Definition\n\nThe logistic curve maps reals to (0, 1).\n\nSecond paragraph about gradients.\n\n- [ ] derive the gradient\n- [x] plot the curve\n'),
  buildEntry('School/DL Class/Lecture 3.md', '# Lecture 3\n\nSigmoid appears here once.\nflour and water on one line\nmix\n'),
  buildEntry('Inbox/Gradient notes.md', '# Gradient notes\n\n## Sigmoid trick\n\nNothing else.\n'),
].map(toSearchDoc);
const find = (q: string) => search(parseQuery(q), docs).map((h) => h.title);

describe('search', () => {
  it('ranks a title match over a heading match over a body match', () => {
    expect(find('sigmoid')).toEqual(['Sigmoid', 'Gradient notes', 'Lecture 3']);
  });
  it('handles AND, phrases, OR, exclusion and regex', () => {
    expect(find('logistic gradients')).toEqual(['Sigmoid']);
    expect(find('"logistic curve"')).toEqual(['Sigmoid']);
    expect(find('"curve logistic"')).toEqual([]);
    expect(find('sigmoid -lecture')).toEqual(['Sigmoid', 'Gradient notes']);
    expect(find('flour OR derive').sort()).toEqual(['Lecture 3', 'Sigmoid']);
    expect(find('/\\(0, 1\\)/')).toEqual(['Sigmoid']);
  });
  it('scopes with file:, path:, content: and tag:', () => {
    expect(find('file:lecture')).toEqual(['Lecture 3']);
    expect(find('path:School')).toEqual(['Lecture 3']);
    expect(find('content:appears')).toEqual(['Lecture 3']);
    expect(find('tag:ml')).toEqual(['Sigmoid']);
    expect(find('tag:#concept')).toEqual(['Sigmoid']);
    expect(find('tag:basics')).toEqual([]);
  });
  it('keeps line:, block: and section: inside one unit', () => {
    expect(find('line:(flour water)')).toEqual(['Lecture 3']);
    expect(find('line:(flour mix)')).toEqual([]);
    expect(find('block:(logistic reals)')).toEqual(['Sigmoid']);
    expect(find('block:(logistic gradients)')).toEqual([]);
    expect(find('section:(logistic gradients)')).toEqual(['Sigmoid']);
  });
  it('reads task state', () => {
    expect(find('task:derive')).toEqual(['Sigmoid']);
    expect(find('task-todo:plot')).toEqual([]);
    expect(find('task-done:plot')).toEqual(['Sigmoid']);
  });
  it('respects match-case', () => {
    expect(find('match-case:sigmoid')).toEqual([]);
    expect(find('match-case:Sigmoid')).toHaveLength(3);
  });
  it('keeps the best hits within the limit', () => {
    expect(search(parseQuery('sigmoid'), docs, 2).map((h) => h.title)).toEqual(['Sigmoid', 'Gradient notes']);
  });
  it('searches a 1 MB note fast', () => {
    const big = toSearchDoc(buildEntry('Big.md', Array.from({ length: 20_000 }, (_, i) => `Line ${i} says something ordinary.`).join('\n') + '\nneedle at the end\n'));
    const t0 = performance.now();
    expect(search(parseQuery('needle -haystack line:(needle end)'), [big])).toHaveLength(1);
    expect(performance.now() - t0).toBeLessThan(budgetMs(500));
  }, PERF_TIMEOUT);
});
