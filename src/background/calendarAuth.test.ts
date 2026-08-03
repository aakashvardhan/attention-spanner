import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Google Calendar token lifecycle. `chrome` has to exist before
 * shared/storage.ts is imported (it feature-detects chrome.storage at module
 * load), so the stub is installed in a hoisted block that runs ahead of the
 * imports below.
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
import type { CalendarState } from '../shared/calendar';
import { CALENDAR_DEFAULTS } from '../shared/calendar';
import {
  AUTH_ERROR_HINT,
  NOT_CONNECTED_HINT,
  getAccessToken,
  refreshAccessToken,
} from './calendarAuth';

const CONNECTED: CalendarState = {
  ...CALENDAR_DEFAULTS,
  clientId: 'client-id',
  clientSecret: 'client-secret',
  connected: true,
  accessToken: 'access-old',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + 3_600_000,
};

function seed(patch: Partial<CalendarState> = {}): void {
  store.calendar = { ...CONNECTED, ...patch };
}

const stored = () => store.calendar as CalendarState;

/** One canned token-endpoint response. */
function mockTokenResponse(body: unknown, ok = true, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  vi.unstubAllGlobals();
});

describe('getAccessToken', () => {
  it('returns the stored token while it is still fresh', async () => {
    seed();
    const fetchMock = mockTokenResponse({});
    expect(await getAccessToken()).toBe('access-old');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes once the token is inside the expiry skew', async () => {
    // Still technically valid, but too close to expiry to hand out — a request
    // in flight would 401 mid-call otherwise.
    seed({ expiresAt: Date.now() + CALENDAR_EXPIRY_SKEW_MS - 1_000 });
    mockTokenResponse({ access_token: 'access-new', expires_in: 3600 });
    expect(await getAccessToken()).toBe('access-new');
    expect(stored().accessToken).toBe('access-new');
  });

  it('refuses when the account is not connected', async () => {
    seed({ connected: false });
    await expect(getAccessToken()).rejects.toThrow(NOT_CONNECTED_HINT);
  });

  it('refuses when connected but holding no token', async () => {
    seed({ accessToken: '' });
    await expect(getAccessToken()).rejects.toThrow(NOT_CONNECTED_HINT);
  });
});

describe('refreshAccessToken', () => {
  it('keeps the existing refresh token when the response omits one', async () => {
    // Google returns refresh_token only on the first grant. Overwriting it
    // with undefined here would break every later refresh.
    seed();
    mockTokenResponse({ access_token: 'access-new', expires_in: 3600 });
    await refreshAccessToken();
    expect(stored().refreshToken).toBe('refresh-1');
    expect(stored().accessToken).toBe('access-new');
    expect(stored().lastError).toBe('');
  });

  it('adopts a rotated refresh token when one comes back', async () => {
    seed();
    mockTokenResponse({ access_token: 'access-new', refresh_token: 'refresh-2', expires_in: 3600 });
    await refreshAccessToken();
    expect(stored().refreshToken).toBe('refresh-2');
  });

  it('sends the grant Google expects', async () => {
    seed();
    const fetchMock = mockTokenResponse({ access_token: 'access-new', expires_in: 3600 });
    await refreshAccessToken();
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
    expect(body.get('client_id')).toBe('client-id');
    expect(body.get('client_secret')).toBe('client-secret');
  });

  it('disconnects when the grant is gone, hiding Google’s wording', async () => {
    seed();
    mockTokenResponse({ error: 'invalid_grant' }, false, 400);
    await expect(refreshAccessToken()).rejects.toThrow(AUTH_ERROR_HINT);
    expect(stored().connected).toBe(false);
    expect(stored().accessToken).toBe('');
    expect(stored().refreshToken).toBe('');
    expect(stored().lastError).toBe(AUTH_ERROR_HINT);
  });

  it('disconnects without calling Google when there is no refresh token', async () => {
    seed({ refreshToken: '' });
    const fetchMock = mockTokenResponse({});
    await expect(refreshAccessToken()).rejects.toThrow(AUTH_ERROR_HINT);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stored().connected).toBe(false);
  });

  it('disconnects when the OAuth client was cleared from Settings', async () => {
    seed({ clientSecret: '' });
    const fetchMock = mockTokenResponse({});
    await expect(refreshAccessToken()).rejects.toThrow(AUTH_ERROR_HINT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the user’s OAuth client across a disconnect', async () => {
    // The credentials are the user's own app registration, not their session —
    // wiping them would make reconnecting a re-setup.
    seed();
    mockTokenResponse({ error: 'invalid_grant' }, false, 400);
    await expect(refreshAccessToken()).rejects.toThrow(AUTH_ERROR_HINT);
    expect(stored().clientId).toBe('client-id');
    expect(stored().clientSecret).toBe('client-secret');
  });

  it('treats a 200 with no access_token as a failed refresh', async () => {
    seed();
    mockTokenResponse({ expires_in: 3600 });
    await expect(refreshAccessToken()).rejects.toThrow(AUTH_ERROR_HINT);
    expect(stored().connected).toBe(false);
  });
});
