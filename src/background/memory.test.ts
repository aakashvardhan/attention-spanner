import { describe, expect, it } from 'vitest';
import { FACT_MAX_CHARS, MAX_ASSISTANT_FACTS } from '../shared/constants';
import type { AssistantFact } from '../shared/types';
import { upsertFact } from './memory';

function fact(id: string, text: string, at: number): AssistantFact {
  return { id, text, createdAt: at, updatedAt: at };
}

describe('upsertFact', () => {
  it('adds a trimmed, whitespace-collapsed fact', () => {
    const res = upsertFact([], '  I lift   Mon/Wed/Fri  ', 100);
    expect(res).not.toBeNull();
    expect(res!.fact.text).toBe('I lift Mon/Wed/Fri');
    expect(res!.fact.createdAt).toBe(100);
    expect(res!.facts).toHaveLength(1);
  });

  it('rejects empty input', () => {
    expect(upsertFact([], '   ', 100)).toBeNull();
  });

  it('caps fact length', () => {
    const res = upsertFact([], 'x'.repeat(FACT_MAX_CHARS + 50), 100);
    expect(res!.fact.text).toHaveLength(FACT_MAX_CHARS);
  });

  it('dedupes case-insensitively by bumping updatedAt', () => {
    const existing = [fact('a', 'My advisor is Dr. Lee', 100)];
    const res = upsertFact(existing, 'my advisor is dr. lee', 200);
    expect(res!.facts).toHaveLength(1);
    expect(res!.fact.id).toBe('a');
    expect(res!.fact.text).toBe('My advisor is Dr. Lee');
    expect(res!.fact.updatedAt).toBe(200);
    expect(res!.facts[0].createdAt).toBe(100);
  });

  it('evicts the oldest fact past the cap', () => {
    const full = Array.from({ length: MAX_ASSISTANT_FACTS }, (_, i) =>
      fact(`f${i}`, `Fact number ${i}`, i + 1),
    );
    const res = upsertFact(full, 'The newest fact', 1000);
    expect(res!.facts).toHaveLength(MAX_ASSISTANT_FACTS);
    expect(res!.facts.some((f) => f.text === 'The newest fact')).toBe(true);
    expect(res!.facts.some((f) => f.id === 'f0')).toBe(false); // oldest evicted
    expect(res!.facts.some((f) => f.id === 'f1')).toBe(true);
  });
});
