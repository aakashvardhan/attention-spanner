import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Gmail token lifecycle, with the emphasis on what differs from Calendar:
 * several grants side by side, where one failing must not disturb the others.
 * `chrome` has to exist before shared/storage.ts is imported (it feature-
 * detects chrome.storage at load), hence the hoisted stub.
 */
const store = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: (keys: string[]) =>
          Promise.resolve(Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]))),
        set: (items: Record<string, unknown>) => {
          Object.assign(data, items);
          return Promise.resolve();
        },
      },
    },
  };
  return data;
});

import { CALENDAR_EXPIRY_SKEW_MS } from '../shared/constants';
import { GMAIL_DEFAULTS, type GmailAccount, type GmailState } from '../shared/gmail';
import { AUTH_ERROR_HINT, getAccessToken, refreshAccessToken } from './gmailAuth';

function account(overrides: Partial<GmailAccount> = {}): GmailAccount {
  return {
    id: 'a1',
    email: 'me@example.com',
    accessToken: 'access-old',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() + 3_600_000,
    connected: true,
    lastError: '',
    ...overrides,
  };
}

function seed(accounts: GmailAccount[]): void {
  store.gmail = {
    ...GMAIL_DEFAULTS,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    accounts,
  } satisfies GmailState;
}

const stored = () => store.gmail as GmailState;
const accountById = (id: string) => stored().accounts.find((a) => a.id === id);

function mockTokenResponse(body: unknown, ok = true, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({ ok, status, json: () => Promise.resolve(body) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  vi.unstubAllGlobals();
});

describe('getAccessToken', () => {
  it('returns the stored token while it is still fresh', async () => {
    seed([account()]);
    const fetchMock = mockTokenResponse({});
    expect(await getAccessToken('a1')).toBe('access-old');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes once the token is inside the expiry skew', async () => {
    seed([account({ expiresAt: Date.now() + CALENDAR_EXPIRY_SKEW_MS - 1000 })]);
    mockTokenResponse({ access_token: 'access-new', expires_in: 3600 });
    expect(await getAccessToken('a1')).toBe('access-new');
    expect(accountById('a1')?.accessToken).toBe('access-new');
  });

  it('rejects an account that is not connected', async () => {
    seed([account({ connected: false, accessToken: '' })]);
    await expect(getAccessToken('a1')).rejects.toThrow('not connected');
  });

  it('rejects an unknown account id', async () => {
    seed([account()]);
    await expect(getAccessToken('nope')).rejects.toThrow('not connected');
  });
});

describe('refreshAccessToken', () => {
  it('keeps the old refresh token when the response omits one', async () => {
    seed([account()]);
    mockTokenResponse({ access_token: 'access-new', expires_in: 3600 });
    await refreshAccessToken('a1');
    expect(accountById('a1')?.refreshToken).toBe('refresh-1');
  });

  it('takes a rotated refresh token when Google sends one', async () => {
    seed([account()]);
    mockTokenResponse({ access_token: 'access-new', refresh_token: 'refresh-2', expires_in: 3600 });
    await refreshAccessToken('a1');
    expect(accountById('a1')?.refreshToken).toBe('refresh-2');
  });

  it('clears the account and surfaces the reconnect hint when the grant is gone', async () => {
    seed([account()]);
    mockTokenResponse({ error: 'invalid_grant' }, false, 400);
    await expect(refreshAccessToken('a1')).rejects.toThrow(AUTH_ERROR_HINT);

    const a = accountById('a1');
    expect(a?.connected).toBe(false);
    expect(a?.accessToken).toBe('');
    expect(a?.refreshToken).toBe('');
    expect(a?.lastError).toBe(AUTH_ERROR_HINT);
  });

  it('leaves the other mailbox untouched when one grant dies', async () => {
    seed([account(), account({ id: 'a2', email: 'school@sjsu.edu', refreshToken: 'refresh-2' })]);
    mockTokenResponse({ error: 'admin_policy_enforced' }, false, 403);
    await expect(refreshAccessToken('a2')).rejects.toThrow(AUTH_ERROR_HINT);

    expect(accountById('a2')?.connected).toBe(false);
    const survivor = accountById('a1');
    expect(survivor?.connected).toBe(true);
    expect(survivor?.accessToken).toBe('access-old');
    expect(survivor?.lastError).toBe('');
  });

  it('disconnects when the client credentials have been cleared', async () => {
    seed([account()]);
    store.gmail = { ...stored(), clientId: '', clientSecret: '' };
    await expect(refreshAccessToken('a1')).rejects.toThrow(AUTH_ERROR_HINT);
    expect(accountById('a1')?.connected).toBe(false);
  });
});
