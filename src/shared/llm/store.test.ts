import { describe, expect, it, vi } from 'vitest';
import type { AiCacheEntry } from '../types';
import { cacheGet, hashText } from './store';

const aiCache: Record<string, AiCacheEntry> = {
  old: { text: 'x', target: 'retired', model: 'old-model', at: 1 },
  live: { text: 'y', target: 'claude', model: 'claude-haiku', at: 2 },
};
vi.mock('../storage', () => ({ getLocal: async () => ({ aiCache }), setLocal: async () => undefined }));

describe('cacheGet', () => {
  it('treats an entry from a removed target as a miss and returns a live one unchanged', async () => {
    expect(await cacheGet('old')).toBeNull();
    expect(await cacheGet('live')).toEqual(aiCache.live);
    expect(await cacheGet('missing')).toBeNull();
  });
});

describe('hashText', () => {
  it('is stable and distinguishes near-identical text', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
  });
});
