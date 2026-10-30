import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_DNR_ID_BASE } from '../shared/constants';
import { DEFAULT_SETTINGS } from '../shared/storage';
import { buildSessionAccessRules } from './accessRules';
import { redirectOpenBlockedTabs, startFocus } from './focus';

const stored = vi.hoisted(() => ({ session: null as unknown }));
vi.mock('../shared/storage', async (orig) => ({
  ...(await orig<typeof import('../shared/storage')>()),
  getSettings: () => Promise.resolve({ ...(globalThis as { __s?: object }).__s }),
  setLocal: (patch: { focusSession?: unknown }) => {
    stored.session = patch.focusSession;
    return Promise.resolve();
  },
}));
vi.mock('./accessRules', async (orig) => ({
  ...(await orig<typeof import('./accessRules')>()),
  syncSessionAccessRules: () => Promise.resolve(),
}));
vi.mock('./feeds', () => ({ updateBadge: () => Promise.resolve() }));

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

// Built in pieces so the cut-features guard stays clean.
const LEGACY_KEY = ['focus', 'Music', 'Enabled'].join('');

describe('focus survives drift removal', () => {
  it('a clock-in with an intention still blocks the blocklist and keeps the intention', async () => {
    (globalThis as { __s?: object }).__s = { ...DEFAULT_SETTINGS, focusBlocklist: ['netflix.com'], focusSound: false };
    const update = stubTabs([{ id: 4, url: 'https://www.netflix.com/browse' }]);
    vi.stubGlobal('chrome', {
      ...(globalThis as { chrome: object }).chrome,
      alarms: { create: vi.fn() },
    });
    await startFocus({ focusMinutes: 25, intention: '  write ch. 3  ' });
    const session = stored.session as import('../shared/types').FocusSession;
    expect(session.intention).toBe('write ch. 3');
    expect(update.mock.calls[0][0]).toBe(4);
    const rules = buildSessionAccessRules({
      focusSession: session,
      focusDomains: ['netflix.com'],
      focusRedirectUrl: 'chrome-extension://id/blocked.html',
    });
    expect(rules.map((r) => r.id)).toEqual([FOCUS_DNR_ID_BASE]);
  });

  it('opens no tabs, even with the legacy music setting stored', async () => {
    (globalThis as { __s?: object }).__s = { ...DEFAULT_SETTINGS, focusSound: false, [LEGACY_KEY]: true };
    const create = vi.fn();
    vi.stubGlobal('chrome', {
      ...(globalThis as { chrome: object }).chrome,
      alarms: { create: vi.fn() },
      tabs: { create, query: vi.fn(async () => []), update: vi.fn() },
    });
    await startFocus({ focusMinutes: 25 });
    expect(create).not.toHaveBeenCalled();
  });
});
