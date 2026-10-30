import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/storage';
import { gateNewItem, topicVerdict } from './topicGate';

const store: Record<string, unknown> = {};

function stubAsk(answer: boolean | null, delayMs = 0) {
  const ask = vi.fn(
    () => new Promise<boolean | null>((resolve) => (delayMs ? setTimeout(() => resolve(answer), delayMs) : resolve(answer))),
  );
  return ask;
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  store.settings = { ...DEFAULT_SETTINGS, geminiTopicKey: 'k' };
  const get = (keys: string | string[]) =>
    Promise.resolve(Object.fromEntries([keys].flat().filter((k) => k in store).map((k) => [k, structuredClone(store[k])])));
  const set = (o: Record<string, unknown>) => Promise.resolve(void Object.assign(store, o));
  vi.stubGlobal('chrome', { storage: { local: { get, set }, session: { get, set } } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('topicVerdict', () => {
  it('keyword match skips Gemini', async () => {
    const ask = stubAsk(false);
    expect(await topicVerdict('a.com/x', 'New robot hand demo a.com', { ask })).toBe(true);
    expect(ask).toHaveBeenCalledTimes(0);
  });

  it('empty topics skip Gemini', async () => {
    store.settings = { ...DEFAULT_SETTINGS, trackTopics: [], geminiTopicKey: 'k' };
    const ask = stubAsk(false);
    expect(await topicVerdict('a.com/x', 'Pasta recipe a.com', { ask })).toBe(true);
    expect(ask).toHaveBeenCalledTimes(0);
  });

  it('Gemini keeps a borderline title', async () => {
    const ask = stubAsk(true);
    expect(await topicVerdict('a.com/x', 'Why scaling laws bend a.com', { ask })).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]).toEqual([
      expect.objectContaining({ apiKey: 'k', text: 'Why scaling laws bend a.com' }),
    ]);
  });

  it('Gemini drops an off-topic title', async () => {
    const ask = stubAsk(false);
    expect(await topicVerdict('a.com/x', 'Pasta recipe a.com', { ask })).toBe(false);
    expect(await gateNewItem('a.com/y', 'Pasta recipe a.com', async () => {}, { ask })).toBe('drop');
  });

  it('no key: keyword miss drops', async () => {
    store.settings = { ...DEFAULT_SETTINGS };
    const ask = stubAsk(true);
    expect(await topicVerdict('a.com/x', 'Pasta recipe a.com', { ask })).toBe(false);
    expect(await gateNewItem('a.com/x', 'Pasta recipe a.com', async () => {}, { ask })).toBe('drop');
    expect(await topicVerdict('a.com/y', 'New robot hand demo a.com', { ask })).toBe(true);
    expect(ask).toHaveBeenCalledTimes(0);
  });

  it('key set, Gemini error keeps', async () => {
    const ask = stubAsk(null);
    expect(await gateNewItem('a.com/x', 'Pasta recipe a.com', async () => {}, { ask })).toBe('keep');
    expect(store.topicVerdicts).toBeUndefined();
  });

  it('concurrent asks for one key share a call', async () => {
    const ask = stubAsk(false);
    const both = await Promise.all([
      topicVerdict('k', 'Pasta recipe a.com', { ask }),
      topicVerdict('k', 'Pasta recipe a.com', { ask }),
    ]);
    expect(both).toEqual([false, false]);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('a new title for one key is a new question', async () => {
    const ask = stubAsk(false);
    await topicVerdict('yt:x', 'Old video title Chan', { ask });
    await topicVerdict('yt:x', 'New video title Chan', { ask });
    expect(ask).toHaveBeenCalledTimes(2);
    await topicVerdict('yt:x', 'New video title Chan', { ask });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('changed topics are a new question', async () => {
    const ask = stubAsk(false);
    await topicVerdict('a.com/x', 'Pasta recipe a.com', { ask });
    store.settings = { ...DEFAULT_SETTINGS, trackTopics: ['cooking'], geminiTopicKey: 'k' };
    await topicVerdict('a.com/x', 'Pasta recipe a.com', { ask });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('cache answers repeat', async () => {
    const ask = stubAsk(false);
    await topicVerdict('a.com/x', 'Pasta recipe a.com', { ask });
    expect(await topicVerdict('a.com/x', 'Pasta recipe a.com', { ask })).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe('gateNewItem', () => {
  it('timeout keeps, late drop removes', async () => {
    vi.useFakeTimers();
    const ask = stubAsk(false, 2000);
    const onLateDrop = vi.fn(async () => {});
    let result: string | undefined;
    void gateNewItem('a.com/x', 'Pasta recipe a.com', onLateDrop, { ask }).then((r) => (result = r));

    await vi.advanceTimersByTimeAsync(1499);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe('keep');
    expect(onLateDrop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(onLateDrop).toHaveBeenCalledTimes(1);
  });

  it('a late keep does not remove', async () => {
    vi.useFakeTimers();
    const onLateDrop = vi.fn(async () => {});
    const gate = gateNewItem('a.com/x', 'Pasta recipe a.com', onLateDrop, { ask: stubAsk(true, 2000) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await gate).toBe('keep');
    expect(onLateDrop).not.toHaveBeenCalled();
  });
});
