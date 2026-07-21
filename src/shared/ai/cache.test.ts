import { beforeEach, describe, expect, it } from 'vitest';
import {
  cacheGet,
  cacheInvalidateTag,
  cacheResetMemory,
  cacheSet,
  hash32,
  LruTtlCache,
  normalizeUtterance,
} from './cache';

describe('LruTtlCache', () => {
  it('stores, expires, and refreshes recency', () => {
    const cache = new LruTtlCache<string>(10);
    cache.set('a', 'A', 1000, 'x', 0);
    expect(cache.get('a', 500)).toBe('A');
    expect(cache.get('a', 1000)).toBeUndefined(); // expired
  });

  it('evicts the least recently used entry over capacity', () => {
    const cache = new LruTtlCache<number>(2);
    cache.set('a', 1, 10_000, 'x', 0);
    cache.set('b', 2, 10_000, 'x', 0);
    cache.get('a', 1); // 'a' now most recent
    cache.set('c', 3, 10_000, 'x', 2);
    expect(cache.get('b', 3)).toBeUndefined();
    expect(cache.get('a', 3)).toBe(1);
    expect(cache.get('c', 3)).toBe(3);
  });

  it('deletes by tag', () => {
    const cache = new LruTtlCache<number>(10);
    cache.set('a', 1, 10_000, 'data', 0);
    cache.set('b', 2, 10_000, 'intent', 0);
    cache.deleteTag('data');
    expect(cache.get('a', 1)).toBeUndefined();
    expect(cache.get('b', 1)).toBe(2);
  });
});

describe('normalizeUtterance', () => {
  it('lowercases, collapses whitespace, drops trailing punctuation', () => {
    expect(normalizeUtterance('  How many  Tasks do I have?! ')).toBe(
      'how many tasks do i have',
    );
    expect(normalizeUtterance("what's my streak")).toBe("what's my streak");
  });
});

describe('hash32', () => {
  it('is stable and input-sensitive', () => {
    expect(hash32('abc')).toBe(hash32('abc'));
    expect(hash32('abc')).not.toBe(hash32('abd'));
    expect(hash32('')).toBe(hash32(''));
  });
});

describe('two-tier cache (memory tier in vitest — no chrome)', () => {
  beforeEach(() => cacheResetMemory());

  it('round-trips values and honours tag invalidation', async () => {
    await cacheSet('intent:add a task', { intent: 'action', tool: 'add_task' }, 60_000, 'intent');
    await cacheSet('ctx:data', 'Open tasks: none.', 60_000, 'data');
    expect(await cacheGet('intent:add a task')).toEqual({ intent: 'action', tool: 'add_task' });
    expect(await cacheGet('ctx:data')).toBe('Open tasks: none.');

    await cacheInvalidateTag('data');
    expect(await cacheGet('ctx:data')).toBeUndefined();
    expect(await cacheGet('intent:add a task')).toEqual({ intent: 'action', tool: 'add_task' });
  });

  it('refuses oversized values', async () => {
    await cacheSet('big', 'x'.repeat(10_000), 60_000, 'data');
    expect(await cacheGet('big')).toBeUndefined();
  });
});
