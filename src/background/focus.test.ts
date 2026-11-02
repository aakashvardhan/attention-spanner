import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_DNR_ID_BASE } from '../shared/constants';
import { DEFAULT_SETTINGS } from '../shared/storage';
import { buildSessionAccessRules } from './accessRules';
import { readerClosed, readerOpened, redirectOpenBlockedTabs } from './focus';

const stored = vi.hoisted(() => ({ session: null as unknown }));
vi.mock('../shared/storage', async (orig) => ({
  ...(await orig<typeof import('../shared/storage')>()),
  getSettings: () => Promise.resolve({ ...(globalThis as { __s?: object }).__s }),
  getLocal: () => Promise.resolve({ focusSession: stored.session }),
  setLocal: (patch: { focusSession?: unknown }) => {
    stored.session = patch.focusSession;
    return Promise.resolve();
  },
}));
vi.mock('./accessRules', async (orig) => ({
  ...(await orig<typeof import('./accessRules')>()),
  syncSessionAccessRules: () => Promise.resolve(),
}));
vi.mock('../shared/activity', () => ({ logActivity: () => Promise.resolve() }));

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

describe('reading session', () => {
  it('the first reader tab starts blocking and redirects open blocked tabs', async () => {
    (globalThis as { __s?: object }).__s = { ...DEFAULT_SETTINGS, focusBlocklist: ['netflix.com'] };
    stored.session = null;
    const update = stubTabs([{ id: 4, url: 'https://www.netflix.com/browse' }]);
    await readerOpened(9, 'Attention Is All You Need');
    const session = stored.session as import('../shared/types').FocusSession;
    expect(session.tabIds).toEqual([9]);
    expect(session.title).toBe('Attention Is All You Need');
    expect(update.mock.calls[0][0]).toBe(4);
    const rules = buildSessionAccessRules({
      focusSession: session,
      focusDomains: ['netflix.com'],
      focusRedirectUrl: 'chrome-extension://id/blocked.html',
    });
    expect(rules.map((r) => r.id)).toEqual([FOCUS_DNR_ID_BASE]);
  });

  it('closing the last reader tab ends the session and lifts the rules', async () => {
    stored.session = { startedAt: Date.now() - 60_000, tabIds: [9], title: 'x' };
    await readerClosed(9);
    expect(stored.session).toBeNull();
    expect(buildSessionAccessRules({ focusSession: null, focusDomains: ['netflix.com'], focusRedirectUrl: 'r' })).toEqual([]);
  });

  it('closing an unrelated tab leaves the session alone', async () => {
    const before = { startedAt: 1, tabIds: [9], title: 'x' };
    stored.session = before;
    await readerClosed(3);
    expect(stored.session).toBe(before);
  });
});
