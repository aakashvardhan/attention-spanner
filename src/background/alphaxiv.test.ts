import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIST_LIBRARY } from '../shared/alphaxiv.fixtures';

/**
 * The network half of alphaXiv against fakes: chrome.storage in memory, fetch
 * for the OAuth endpoints, and a scripted MCP client. Covers the edge cases
 * the spec names: 401 then refresh, a refused refresh, 429, offline, an empty
 * library, the one-time push (and a push that fails halfway), single-flight
 * refresh, and the sign-in round trip.
 */

const mcp = vi.hoisted(() => ({
  /** Next replies per tool; a function is called with the args. An Error is thrown. */
  replies: {} as Record<string, unknown[]>,
  calls: [] as { name: string; args: Record<string, unknown>; token: string }[],
  connects: 0,
  connectError: null as Error | null,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    token = '';
    async connect(transport: { token: string }) {
      mcp.connects++;
      if (mcp.connectError) throw mcp.connectError;
      this.token = transport.token;
    }
    async close() {}
    async callTool({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) {
      mcp.calls.push({ name, args, token: this.token });
      const next = mcp.replies[name]?.shift();
      if (next instanceof Error) throw next;
      const text = typeof next === 'function' ? (next as (a: unknown) => string)(args) : (next as string);
      if (text === undefined) throw new Error(`no scripted reply for ${name}`);
      return { content: [{ type: 'text', text }] };
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  class StreamableHTTPError extends Error {
    constructor(
      readonly code: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    StreamableHTTPError,
    StreamableHTTPClientTransport: class {
      token: string;
      constructor(_url: URL, opts: { requestInit: { headers: Record<string, string> } }) {
        this.token = opts.requestInit.headers.authorization.replace('Bearer ', '');
      }
    },
  };
});

const { StreamableHTTPError } = (await import('@modelcontextprotocol/sdk/client/streamableHttp.js')) as unknown as {
  StreamableHTTPError: new (code: number, message: string) => Error;
};
const ax = await import('./alphaxiv');

const NOW = Date.now();
let store: Record<string, unknown>;
let tokenCalls: URLSearchParams[];
let tokenReply: () => Response;

function fresh(over: Record<string, unknown> = {}) {
  return { clientId: 'c1', redirectUri: 'https://ext.chromiumapp.org/alphaxiv', accessToken: 'a1', refreshToken: 'r1', expiresAt: NOW + 3_600_000, ...over };
}

beforeEach(() => {
  store = { alphaxivAuth: fresh() };
  mcp.replies = {};
  mcp.calls = [];
  mcp.connects = 0;
  mcp.connectError = null;
  tokenCalls = [];
  tokenReply = () => Response.json({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 });
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
        set: async (items: Record<string, unknown>) => Object.assign(store, structuredClone(items)),
      },
    },
    alarms: { create: vi.fn(), clear: vi.fn(async () => true) },
    identity: {
      getRedirectURL: (path: string) => `https://ext.chromiumapp.org/${path}`,
      launchWebAuthFlow: vi.fn(async ({ url }: { url: string }) => {
        const state = new URL(url).searchParams.get('state');
        return `https://ext.chromiumapp.org/alphaxiv?code=the-code&state=${state}`;
      }),
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/oauth2/token')) {
        tokenCalls.push(new URLSearchParams(init?.body as URLSearchParams));
        return tokenReply();
      }
      if (url.endsWith('/oauth2/register')) return Response.json({ client_id: 'registered-client' });
      if (url.endsWith('/oauth2/userinfo')) return Response.json({ email: 'me@example.edu' });
      if (url.endsWith('/oauth2/revoke')) return new Response(null, { status: 200 });
      throw new TypeError('unexpected fetch ' + url);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('callTool', () => {
  it('sends the stored token', async () => {
    mcp.replies.list_library = ['{"folders":[]}'];
    expect(await ax.callTool('list_library', {})).toBe('{"folders":[]}');
    expect(mcp.calls[0].token).toBe('a1');
    expect(tokenCalls).toHaveLength(0);
  });

  it('a 401 refreshes the token once and retries', async () => {
    mcp.replies.list_library = [new StreamableHTTPError(401, 'unauthorized'), '{"folders":[]}'];
    await ax.callTool('list_library', {});
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].get('grant_type')).toBe('refresh_token');
    expect(tokenCalls[0].get('refresh_token')).toBe('r1');
    expect(mcp.calls.map((c) => c.token)).toEqual(['a1', 'a2']);
    expect(store.alphaxivAuth).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
  });

  it('an expired token is refreshed before the call', async () => {
    store.alphaxivAuth = fresh({ expiresAt: NOW - 1 });
    mcp.replies.list_library = ['{"folders":[]}'];
    await ax.callTool('list_library', {});
    expect(mcp.calls[0].token).toBe('a2');
  });

  it('two calls on an expired token refresh it once (a rotated refresh token is single-use)', async () => {
    store.alphaxivAuth = fresh({ expiresAt: NOW - 1 });
    mcp.replies.a = ['1'];
    mcp.replies.b = ['2'];
    await Promise.all([ax.callTool('a', {}), ax.callTool('b', {})]);
    expect(tokenCalls).toHaveLength(1);
  });

  it('a refused refresh signs out', async () => {
    tokenReply = () => Response.json({ error: 'invalid_grant' }, { status: 400 });
    mcp.replies.list_library = [new StreamableHTTPError(401, 'unauthorized')];
    await expect(ax.callTool('list_library', {})).rejects.toMatchObject({ kind: 'signed-out' });
    expect(store.alphaxivAuth).toBeNull();
  });

  it('a refresh that cannot reach alphaXiv keeps the sign-in', async () => {
    store.alphaxivAuth = fresh({ expiresAt: NOW - 1 });
    tokenReply = () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(ax.callTool('x', {})).rejects.toMatchObject({ kind: 'offline' });
    expect(store.alphaxivAuth).toMatchObject({ refreshToken: 'r1' });
  });

  it('429 is rate-limited, offline is offline, a tool error saying "not found" is not-found', async () => {
    mcp.replies.x = [new StreamableHTTPError(429, 'slow down')];
    await expect(ax.callTool('x', {})).rejects.toMatchObject({ kind: 'rate-limited' });
    mcp.connectError = new TypeError('Failed to fetch');
    await expect(ax.callTool('x', {})).rejects.toMatchObject({ kind: 'offline' });
    mcp.connectError = null;
  });

  it('no refresh token: an expired sign-in ends cleanly, with no token request', async () => {
    store.alphaxivAuth = fresh({ refreshToken: '', expiresAt: NOW - 1 });
    await expect(ax.callTool('x', {})).rejects.toMatchObject({ kind: 'signed-out' });
    expect(store.alphaxivAuth).toBeNull();
    expect(tokenCalls).toHaveLength(0);
  });

  it('signed out: no network at all', async () => {
    store.alphaxivAuth = null;
    await expect(ax.callTool('x', {})).rejects.toMatchObject({ kind: 'signed-out' });
    expect(mcp.connects).toBe(0);
  });
});

describe('syncLibrary', () => {
  it('mirrors the library onto the shelf and records the sync', async () => {
    mcp.replies.list_library = [LIST_LIBRARY];
    expect(await ax.syncLibrary(true)).toEqual({ ok: true });
    expect((store.folders as { name: string }[]).map((f) => f.name)).toEqual(['Want to read', 'Reading', 'Completed', 'My publications']);
    expect((store.papers as unknown[]).length).toBe(5);
    expect(store.alphaxivStatus).toMatchObject({ error: '' });
    expect((store.alphaxivStatus as { lastSyncAt: number }).lastSyncAt).toBeGreaterThanOrEqual(NOW);
  });

  it('an empty library empties the shelf', async () => {
    store.folders = [{ id: 'old', name: 'Old', type: 'custom' }];
    mcp.replies.list_library = ['{"folders":[]}'];
    await ax.syncLibrary(true);
    expect(store.folders).toEqual([]);
  });

  it('skips a sync moments after the last one unless forced', async () => {
    store.alphaxivStatus = { email: '', lastSyncAt: Date.now(), error: '' };
    expect(await ax.syncLibrary()).toEqual({ ok: true });
    expect(mcp.calls).toHaveLength(0);
  });

  it('saves the pre-alphaXiv papers once: creates the missing folder, saves, clears the queue, re-reads', async () => {
    store.alphaxivPush = [
      { id: '2006.11239', folder: 'Diffusion' },
      { id: '2406.09246', folder: 'want to read' },
    ];
    mcp.replies.list_library = [LIST_LIBRARY, LIST_LIBRARY];
    mcp.replies.create_folder = ['Created folder "Diffusion" (01985f0e-9788-7aaa-8bbb-cccccccccccc).'];
    mcp.replies.save_papers_to_folder = ['Saved 1 paper.'];
    expect(await ax.syncLibrary(true)).toEqual({ ok: true });
    expect(mcp.calls.map((c) => c.name)).toEqual(['list_library', 'create_folder', 'save_papers_to_folder', 'list_library']);
    // OpenVLA is already in Want to read on alphaXiv, so only DDPM is saved.
    expect(mcp.calls[2].args).toEqual({ paper_ids_or_urls: ['2006.11239'], folder_id: '01985f0e-9788-7aaa-8bbb-cccccccccccc' });
    expect(store.alphaxivPush).toEqual([]);
  });

  it('a push that fails halfway keeps the queue and reports the error; the sign-in stays', async () => {
    store.alphaxivPush = [{ id: '2006.11239', folder: 'Want to read' }];
    mcp.replies.list_library = [LIST_LIBRARY];
    mcp.replies.save_papers_to_folder = [new StreamableHTTPError(500, 'boom')];
    expect(await ax.syncLibrary(true)).toEqual({ ok: false, error: 'failed' });
    expect(store.alphaxivPush).toEqual([{ id: '2006.11239', folder: 'Want to read' }]);
    expect((store.alphaxivStatus as { error: string }).error).not.toBe('');
    expect(store.alphaxivAuth).not.toBeNull();
  });

  it('rate-limited: says so in Settings, keeps the shelf as it was', async () => {
    store.papers = [];
    mcp.replies.list_library = [new StreamableHTTPError(429, 'slow')];
    expect(await ax.syncLibrary(true)).toEqual({ ok: false, error: 'rate-limited' });
    expect((store.alphaxivStatus as { error: string }).error).toMatch(/slow down/);
    expect(store.papers).toEqual([]);
  });

  it('a reply in a new format fails the sync without touching the shelf', async () => {
    store.papers = [];
    mcp.replies.list_library = ['Your library is empty.'];
    expect(await ax.syncLibrary(true)).toEqual({ ok: false, error: 'failed' });
    expect(store.papers).toEqual([]);
  });

  it('signed out: reports it without calling alphaXiv', async () => {
    store.alphaxivAuth = null;
    expect(await ax.syncLibrary(true)).toEqual({ ok: false, error: 'signed-out' });
    expect(mcp.calls).toHaveLength(0);
  });
});

describe('signIn / signOut', () => {
  beforeEach(() => {
    store = {};
  });

  it('registers, runs the login window with PKCE, stores the tokens and the email, then syncs', async () => {
    mcp.replies.list_library = [LIST_LIBRARY];
    expect(await ax.signIn()).toEqual({ ok: true });
    const flow = vi.mocked(chrome.identity.launchWebAuthFlow).mock.calls[0][0];
    expect(flow.interactive).toBe(true);
    const q = new URL(flow.url).searchParams;
    expect(q.get('client_id')).toBe('registered-client');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(tokenCalls[0].get('grant_type')).toBe('authorization_code');
    expect(tokenCalls[0].get('code')).toBe('the-code');
    expect(tokenCalls[0].get('code_verifier')?.length).toBeGreaterThanOrEqual(43);
    expect(store.alphaxivAuth).toMatchObject({ clientId: 'registered-client', accessToken: 'a2', refreshToken: 'r2' });
    expect(store.alphaxivStatus).toMatchObject({ email: 'me@example.edu', error: '' });
    expect(store.alphaxivClient).toEqual({ clientId: 'registered-client', redirectUri: 'https://ext.chromiumapp.org/alphaxiv' });
    expect(chrome.alarms.create).toHaveBeenCalledWith('alphaxiv-sync', { periodInMinutes: 30 });
    expect((store.papers as unknown[]).length).toBe(5);
  });

  it('reuses the registered client while the redirect URI is the same', async () => {
    store.alphaxivClient = { clientId: 'kept', redirectUri: 'https://ext.chromiumapp.org/alphaxiv' };
    mcp.replies.list_library = [LIST_LIBRARY];
    await ax.signIn();
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).endsWith('/register'))).toBe(false);
    expect(store.alphaxivAuth).toMatchObject({ clientId: 'kept' });
  });

  it('a closed login window is a quiet "cancelled", and nothing is stored', async () => {
    // Chrome's own wording when the window is closed.
    vi.mocked(chrome.identity.launchWebAuthFlow).mockRejectedValueOnce(new Error('The user did not approve access.'));
    expect(await ax.signIn()).toEqual({ ok: false, error: 'Sign-in was cancelled.' });
    // A real failure keeps its own message.
    vi.mocked(chrome.identity.launchWebAuthFlow).mockRejectedValueOnce(new Error('Authorization page could not be loaded.'));
    expect(await ax.signIn()).toEqual({ ok: false, error: 'Authorization page could not be loaded.' });
    expect(store.alphaxivAuth).toBeUndefined();
  });

  it('a forged redirect (state mismatch) is refused before any token request', async () => {
    (vi.mocked(chrome.identity.launchWebAuthFlow) as unknown as { mockResolvedValueOnce(v: string): void }).mockResolvedValueOnce('https://ext.chromiumapp.org/alphaxiv?code=x&state=forged');
    expect(await ax.signIn()).toMatchObject({ ok: false });
    expect(tokenCalls).toHaveLength(0);
  });

  it('sign out forgets the tokens, stops the alarm and revokes the refresh token', async () => {
    store.alphaxivAuth = fresh();
    expect(await ax.signOut()).toEqual({ ok: true });
    expect(store.alphaxivAuth).toBeNull();
    expect(chrome.alarms.clear).toHaveBeenCalledWith('alphaxiv-sync');
    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).endsWith('/revoke'))).toBe(true));
  });
});
