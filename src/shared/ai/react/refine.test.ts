import { describe, expect, it } from 'vitest';
import type { AssistantProvider, GenerateRequest, ProviderReply } from '../assistantTypes';
import {
  checkSufficiency,
  parseAnswerCritique,
  parseSufficiency,
  refineAnswer,
  worthCritiquing,
} from './refine';

function provider(
  respond: (req: GenerateRequest, n: number) => ProviderReply,
): AssistantProvider & { calls: GenerateRequest[] } {
  const calls: GenerateRequest[] = [];
  return {
    id: 'anthropic',
    calls,
    available: async () => true,
    generate: async (req) => {
      calls.push(req);
      return respond(req, calls.length - 1);
    },
  };
}

const dead = (): AssistantProvider => ({
  id: 'anthropic',
  available: async () => true,
  generate: async () => {
    throw new Error('down');
  },
});

describe('parseAnswerCritique', () => {
  it('reads a clean verdict', () => {
    expect(parseAnswerCritique('{"verdict":"ok","issues":[]}')).toEqual({
      verdict: 'ok',
      issues: [],
      answer: null,
    });
  });

  it('takes the rewritten answer on revise', () => {
    const critique = parseAnswerCritique(
      '{"verdict":"revise","issues":["cited a source that is not there"],"answer":"Fixed."}',
    );
    expect(critique).toEqual({
      verdict: 'revise',
      issues: ['cited a source that is not there'],
      answer: 'Fixed.',
    });
  });

  it('treats an unknown verdict as ok rather than guessing', () => {
    expect(parseAnswerCritique('{"verdict":"maybe"}').verdict).toBe('ok');
  });

  it('ignores an answer supplied alongside verdict ok', () => {
    expect(parseAnswerCritique('{"verdict":"ok","answer":"rewritten"}').answer).toBeNull();
  });

  it('drops blank issues and caps the list', () => {
    const many = JSON.stringify({ verdict: 'revise', issues: ['a', '', ...'bcdefg'.split('')] });
    expect(parseAnswerCritique(many).issues).toHaveLength(5);
  });

  it('throws on junk so callers can treat it as "critic failed"', () => {
    expect(() => parseAnswerCritique('not json')).toThrow();
  });
});

describe('worthCritiquing', () => {
  it('skips a short answer — the cheapest turn must not cost double', () => {
    expect(worthCritiquing('You have 3 open tasks.', 2)).toBe(false);
  });

  it('skips any answer with no evidence to check against', () => {
    expect(worthCritiquing('x'.repeat(400), 0)).toBe(false);
  });

  it('runs on a long answer backed by evidence', () => {
    expect(worthCritiquing('x'.repeat(400), 1)).toBe(true);
  });
});

describe('refineAnswer', () => {
  const chainOf = (p: AssistantProvider) => [p];

  it('returns the draft untouched when the critic says ok', async () => {
    const p = provider(() => ({ text: '{"verdict":"ok","issues":[]}' }));
    const out = await refineAnswer('q', 'draft', 'evidence', chainOf(p));
    expect(out).toEqual({ text: 'draft', issues: [], rounds: 1 });
  });

  it('takes the revision and stops once the critic is satisfied', async () => {
    let round = 0;
    const p = provider(() => {
      round++;
      return round === 1
        ? { text: '{"verdict":"revise","issues":["overstated"],"answer":"A careful answer."}' }
        : { text: '{"verdict":"ok","issues":[]}' };
    });
    const out = await refineAnswer('q', 'draft', 'evidence', chainOf(p));
    expect(out.text).toBe('A careful answer.');
    expect(out.issues).toEqual(['overstated']);
    expect(out.rounds).toBe(2);
  });

  it('stops at the round cap instead of revising forever', async () => {
    const p = provider((_r, n) => ({
      text: `{"verdict":"revise","issues":["again"],"answer":"v${n}"}`,
    }));
    const out = await refineAnswer('q', 'draft', 'evidence', chainOf(p), 2);
    expect(p.calls).toHaveLength(2);
    expect(out.rounds).toBe(2);
  });

  it('stops when a revise carries no replacement, rather than looping', async () => {
    const p = provider(() => ({ text: '{"verdict":"revise","issues":["vague"]}' }));
    const out = await refineAnswer('q', 'draft', 'evidence', chainOf(p));
    expect(p.calls).toHaveLength(1);
    expect(out.text).toBe('draft');
    expect(out.issues).toEqual(['vague']);
  });

  it('NEVER blocks: a thrown critic returns the draft', async () => {
    const out = await refineAnswer('q', 'draft', 'evidence', chainOf(dead()));
    expect(out).toEqual({ text: 'draft', issues: [], rounds: 0 });
  });

  it('NEVER blocks: junk from the critic returns the draft', async () => {
    const p = provider(() => ({ text: 'not json at all' }));
    expect((await refineAnswer('q', 'draft', 'e', chainOf(p))).text).toBe('draft');
  });

  it('does nothing when rounds is zero — the constant is an off switch', async () => {
    const p = provider(() => ({ text: '{"verdict":"revise","answer":"changed"}' }));
    const out = await refineAnswer('q', 'draft', 'e', chainOf(p), 0);
    expect(p.calls).toHaveLength(0);
    expect(out.text).toBe('draft');
  });

  it('does nothing with an empty chain', async () => {
    expect((await refineAnswer('q', 'draft', 'e', [])).text).toBe('draft');
  });
});

describe('parseSufficiency', () => {
  it('only an explicit false means insufficient', () => {
    expect(parseSufficiency('{"sufficient":false,"missing":["the paper title"]}')).toEqual({
      sufficient: false,
      missing: ['the paper title'],
    });
    expect(parseSufficiency('{"sufficient":true}').sufficient).toBe(true);
    // Ambiguity resolves toward answering, never toward blocking
    expect(parseSufficiency('{}').sufficient).toBe(true);
  });

  it('caps the missing list', () => {
    const out = parseSufficiency('{"sufficient":false,"missing":["a","b","c","d","e"]}');
    expect(out.missing).toHaveLength(3);
  });
});

describe('checkSufficiency', () => {
  it('reports what is missing', async () => {
    const p = provider(() => ({ text: '{"sufficient":false,"missing":["your highlights"]}' }));
    expect(await checkSufficiency('q', '', [p])).toEqual({
      sufficient: false,
      missing: ['your highlights'],
    });
  });

  it('defaults to sufficient on failure, so it can only cause MORE looking up', async () => {
    expect(await checkSufficiency('q', '', [dead()])).toEqual({ sufficient: true, missing: [] });
    expect(await checkSufficiency('q', '', [])).toEqual({ sufficient: true, missing: [] });
  });
});
