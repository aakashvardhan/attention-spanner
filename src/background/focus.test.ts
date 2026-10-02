import { afterEach, describe, expect, it, vi } from 'vitest';
import { redirectOpenBlockedTabs } from './focus';

/**
 * "An already-open Netflix tab would defeat the whole point" — so starting a
 * focus session has to reach tabs that were already sitting on a blocked host.
 *
 * This used to be gated on the daily brain-dump gate being complete ("the
 * morning gate owns every web tab until its dump is complete"). When the gate
 * became a dismissible newtab prompt, that guard stopped tracking anything real
 * and quietly turned into a bug: skip today's dump and Focus mode would arm its
 * DNR rules but leave every already-open blocked tab exactly where it was.
 * The gate is gone now, and these pin the behaviour so it cannot come back.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubTabs(tabs: { id?: number; url?: string }[]) {
  const update = vi.fn((_id: number, _props: { url: string }) => Promise.resolve());
  vi.stubGlobal('chrome', {
    tabs: { query: () => Promise.resolve(tabs), update },
    runtime: { getURL: (p: string) => `chrome-extension://id/${p}` },
  });
  return update;
}

describe('redirectOpenBlockedTabs', () => {
  it('redirects an open blocked tab with no gate state present at all', async () => {
    const update = stubTabs([{ id: 7, url: 'https://www.netflix.com/browse' }]);
    await redirectOpenBlockedTabs(['netflix.com']);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toBe(7);
    expect(update.mock.calls[0][1].url).toContain('https://www.netflix.com/browse');
  });

  it('leaves tabs that are not on the blocklist alone', async () => {
    const update = stubTabs([{ id: 1, url: 'https://example.com/a' }]);
    await redirectOpenBlockedTabs(['netflix.com']);
    expect(update).not.toHaveBeenCalled();
  });

  it('skips tabs with no id and unparseable URLs instead of throwing', async () => {
    const update = stubTabs([
      { id: undefined, url: 'https://www.netflix.com/' },
      { id: 2, url: 'not a url' },
      { id: 3 },
    ]);
    await expect(redirectOpenBlockedTabs(['netflix.com'])).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });
});
