import { describe, expect, it } from 'vitest';
import { defineRequest } from './terms';

describe('defineRequest', () => {
  const base = { key: 'doc', word: 'TD', context: 'We use TD learning here.', source: 'web' as const };

  it('sends the passage and names the clicked word', () => {
    const r = defineRequest({ ...base, near: 'use TD learning' });
    expect(r.task).toBe('terms');
    expect(r.passages).toEqual(['We use TD learning here.']);
    expect(r.prompt).toContain('"TD"');
  });

  it('caches per phrase, so the same word in another phrase is defined afresh', () => {
    const a = defineRequest({ ...base, near: 'use TD learning' });
    const b = defineRequest({ ...base, near: 'the TD error' });
    expect(a.cacheKey).not.toBe(b.cacheKey);
  });
});
