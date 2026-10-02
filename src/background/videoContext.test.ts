import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerTimedtextTee } from './videoContext';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * onInstalled and onStartup both register the tee, and on a reload they run at
 * the same time. The guard that reads the registered list first does not make
 * that safe — both callers are told the list is empty before either writes.
 */
function stubScripting(registerImpl: () => Promise<void>) {
  const registered: { id: string; runAt?: string; world?: string }[] = [];
  const registerContentScripts = vi.fn(async (scripts: typeof registered) => {
    registered.push(...scripts);
    await registerImpl();
  });
  vi.stubGlobal('chrome', {
    scripting: {
      // Resolves on a later tick, which is what lets the second caller read the
      // list before the first has registered. A synchronous stub would hide the
      // race the real API has.
      getRegisteredContentScripts: () => new Promise((resolve) => setTimeout(() => resolve([]), 0)),
      registerContentScripts,
    },
  });
  return { registerContentScripts, registered };
}

describe('registerTimedtextTee', () => {
  it('registers the tee once when called alone', async () => {
    const { registerContentScripts, registered } = stubScripting(async () => {});
    await registerTimedtextTee();
    expect(registerContentScripts).toHaveBeenCalledTimes(1);
    expect(registered).toEqual([
      expect.objectContaining({ id: 'yt-timedtext-tee', runAt: 'document_start', world: 'MAIN' }),
    ]);
  });

  it('survives two concurrent callers racing past the guard', async () => {
    let attempts = 0;
    const { registerContentScripts } = stubScripting(async () => {
      // Chrome's own behaviour: whoever gets there second is rejected by id.
      if (++attempts > 1) throw new Error("Duplicate script ID 'yt-timedtext-tee'");
    });

    await expect(
      Promise.all([registerTimedtextTee(), registerTimedtextTee()]),
    ).resolves.toBeDefined();

    // Both really did attempt it — otherwise this test would pass without the
    // race ever happening, and prove nothing.
    expect(registerContentScripts).toHaveBeenCalledTimes(2);
  });

  it('still throws anything that is not a duplicate id', async () => {
    stubScripting(async () => {
      throw new Error('Could not load file: content/timedtextTee.js');
    });
    await expect(registerTimedtextTee()).rejects.toThrow('Could not load file');
  });
});
