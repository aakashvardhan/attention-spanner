import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeQuery, OPS, parseQuery, printQuery, QueryError, type Q } from './query';
import { FC } from './testing';

const term = (v: string, phrase = false): Q => ({ t: 'term', v, phrase });

describe('parseQuery', () => {
  it('reads words, phrases, OR, groups and exclusions', () => {
    expect(parseQuery('meeting work')).toEqual({ t: 'and', a: [term('meeting'), term('work')] });
    expect(parseQuery('a b OR c')).toEqual({ t: 'or', a: [{ t: 'and', a: [term('a'), term('b')] }, term('c')] });
    expect(parseQuery('"star wars" -spoiler')).toEqual({ t: 'and', a: [term('star wars', true), { t: 'not', a: term('spoiler') }] });
    expect(parseQuery('(a OR b) c')).toEqual({ t: 'and', a: [{ t: 'or', a: [term('a'), term('b')] }, term('c')] });
  });
  it('reads every operator and a regex', () => {
    expect(parseQuery('line:(mix flour)')).toEqual({ t: 'op', op: 'line', a: { t: 'and', a: [term('mix'), term('flour')] } });
    expect(parseQuery('tag:#concept task-todo:read')).toEqual({
      t: 'and',
      a: [
        { t: 'op', op: 'tag', a: term('#concept') },
        { t: 'op', op: 'task-todo', a: term('read') },
      ],
    });
    expect(parseQuery('/\\d{4}/')).toEqual({ t: 'regex', v: '\\d{4}' });
    for (const op of OPS.filter((o) => o !== 'tag')) expect(parseQuery(`${op}:x`)).toEqual({ t: 'op', op, a: term('x') });
  });
  it('leaves an unknown prefix as a word, and an empty query as no condition', () => {
    expect(parseQuery('http://example.com')).toEqual(term('http://example.com'));
    expect(parseQuery('  ')).toEqual({ t: 'and', a: [] });
  });
  it.each([
    ['(a b', 'unclosed parenthesis', 0],
    ['a OR', 'expected a search term', 4],
    ['"abc', 'unclosed quote', 0],
    ['/(/', 'invalid regular expression', 0],
    ['file:', '"file:" needs a value', 0],
    ['a )', 'unexpected ")"', 2],
    ['tag:(a b)', '"tag:" takes a tag name', 0],
    ['x -', '"-" needs something to exclude', 2],
  ])('reports %j as "%s" at %i', (src, message, pos) => {
    try {
      parseQuery(src);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QueryError);
      expect((e as QueryError).message).toContain(message);
      expect((e as QueryError).pos).toBe(pos);
    }
  });
});

const word = fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/);
const leaf: fc.Arbitrary<Q> = fc.oneof(
  word.map((v) => term(v)),
  fc.string({ maxLength: 8 }).filter((s) => !/[\r\n]/.test(s)).map((v) => term(v, true)),
  fc.constantFrom('a+b', '\\d{2}', 'x\\/y', '[a-c]').map((v): Q => ({ t: 'regex', v })),
);
const { q } = fc.letrec<{ q: Q; and: Q; or: Q; not: Q; op: Q }>((tie) => ({
  q: fc.oneof({ depthSize: 'small' }, leaf, tie('and'), tie('or'), tie('not'), tie('op')),
  and: fc.array(tie('q'), { minLength: 2, maxLength: 3 }).map((a): Q => ({ t: 'and', a })),
  or: fc.array(tie('q'), { minLength: 2, maxLength: 3 }).map((a): Q => ({ t: 'or', a })),
  not: tie('q').map((a): Q => ({ t: 'not', a })),
  op: fc.tuple(fc.constantFrom(...OPS.filter((o) => o !== 'tag')), tie('q')).map(([op, a]): Q => ({ t: 'op', op, a })),
}));

describe('printQuery', () => {
  it('prints any query so it parses back to the same query', () => {
    // A block body: fast-check reads any return value other than true or undefined as a failure.
    fc.assert(
      fc.property(q, (x) => {
        expect(parseQuery(printQuery(x))).toEqual(normalizeQuery(x));
      }),
      FC,
    );
  });
});
