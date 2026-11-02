import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ALPHAXIV_AUTH,
  ALPHAXIV_MCP_URL,
  ALPHAXIV_SCOPE,
  AlphaxivError,
  authFromTokenReply,
  authorizeUrl,
  codeFromRedirect,
  errorMessage,
  folderKey,
  kindForStatus,
  mergeLibrary,
  needsRefresh,
  parseFolderId,
  parseLibrary,
  pkceChallenge,
  planPush,
  randomToken,
  type AlphaxivAuth,
} from '../shared/alphaxiv';
import { getLocal, setLocal } from '../shared/storage';

/**
 * alphaXiv, the network half: sign-in (OAuth 2.1, PKCE, a public client
 * registered on first use), MCP tool calls, and the library sync. Pure rules
 * live in shared/alphaxiv.ts.
 *
 * The service worker is the only caller: it is the one context that reaches
 * api.alphaxiv.org without CORS (host_permissions), and the single writer
 * keeps two tabs from refreshing the same token at once. alphaXiv rotates
 * refresh tokens, and a reused one can revoke the whole chain.
 */

export const SYNC_ALARM = 'alphaxiv-sync';
/** A new tab opening asks for a sync; one within this window is enough. */
const SYNC_MIN_GAP_MS = 2 * 60_000;

/* ---------- Sign-in ---------- */

async function postForm(url: string, body: Record<string, string>): Promise<unknown> {
  const res = await fetchOrOffline(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new AlphaxivError(res.status === 400 ? 'signed-out' : kindForStatus(res.status), `alphaXiv refused (${res.status}).`);
  return res.json();
}

async function fetchOrOffline(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new AlphaxivError('offline', errorMessage('offline'));
  }
}

/** A client id for this redirect URI: reused while the extension id holds, re-registered when it changes. */
async function clientFor(redirectUri: string): Promise<string> {
  const { alphaxivClient } = await getLocal('alphaxivClient');
  if (alphaxivClient?.redirectUri === redirectUri) return alphaxivClient.clientId;
  const res = await fetchOrOffline(ALPHAXIV_AUTH.register, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ADHD Reader',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: ALPHAXIV_SCOPE,
    }),
  });
  if (!res.ok) throw new AlphaxivError('failed', `alphaXiv would not register this extension (${res.status}).`);
  const { client_id } = (await res.json()) as { client_id?: string };
  if (!client_id) throw new AlphaxivError('failed', 'alphaXiv registered the extension but sent no client id.');
  await setLocal({ alphaxivClient: { clientId: client_id, redirectUri } });
  return client_id;
}

/** Opens alphaXiv's own login window; resolves once signed in and synced. */
export async function signIn(): Promise<{ ok: boolean; error?: string }> {
  try {
    const redirectUri = chrome.identity.getRedirectURL('alphaxiv');
    const clientId = await clientFor(redirectUri);
    const verifier = randomToken();
    const state = randomToken(16);
    const redirect = await chrome.identity
      .launchWebAuthFlow({
        url: authorizeUrl({ clientId, redirectUri, state, challenge: await pkceChallenge(verifier) }),
        interactive: true,
      })
      .catch((e: Error) => {
        // Closing the window is a choice, not a failure worth alarming anyone over.
        throw new AlphaxivError('signed-out', /did not approve|closed|cancel/i.test(e.message) ? 'Sign-in was cancelled.' : e.message);
      });
    const got = codeFromRedirect(redirect ?? '', state);
    if ('error' in got) throw new AlphaxivError('signed-out', got.error);
    const reply = await postForm(ALPHAXIV_AUTH.token, {
      grant_type: 'authorization_code',
      code: got.code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: ALPHAXIV_MCP_URL,
    });
    const auth = authFromTokenReply(reply, { clientId, redirectUri }, Date.now());
    await setLocal({ alphaxivAuth: auth, alphaxivStatus: { email: await emailFor(auth), lastSyncAt: null, error: '' } });
    chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 30 });
    await syncLibrary(true);
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await patchStatus({ error: message });
    return { ok: false, error: message };
  }
}

async function emailFor(auth: AlphaxivAuth): Promise<string> {
  try {
    const res = await fetch(ALPHAXIV_AUTH.userinfo, { headers: { authorization: `Bearer ${auth.accessToken}` } });
    return res.ok ? (((await res.json()) as { email?: string }).email ?? '') : '';
  } catch {
    return '';
  }
}

export async function signOut(): Promise<{ ok: boolean }> {
  const { alphaxivAuth } = await getLocal('alphaxivAuth');
  await setLocal({ alphaxivAuth: null, alphaxivStatus: { email: '', lastSyncAt: null, error: '' } });
  session = null;
  await chrome.alarms.clear(SYNC_ALARM);
  // Best effort: the local copy is already gone, which is what signing out means here.
  if (alphaxivAuth?.refreshToken)
    void fetch(ALPHAXIV_AUTH.revoke, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: alphaxivAuth.refreshToken, client_id: alphaxivAuth.clientId }),
    }).catch(() => undefined);
  return { ok: true };
}

/* ---------- Tokens ---------- */

let refreshing: Promise<AlphaxivAuth> | null = null;

/** A fresh access token. One refresh at a time: a rotated refresh token is single-use. */
async function currentAuth(force = false): Promise<AlphaxivAuth> {
  const { alphaxivAuth } = await getLocal('alphaxivAuth');
  if (!alphaxivAuth) throw new AlphaxivError('signed-out', errorMessage('signed-out'));
  if (!force && !needsRefresh(alphaxivAuth, Date.now())) return alphaxivAuth;
  if (!alphaxivAuth.refreshToken) {
    // Nothing to renew with: the sign-in is over.
    await setLocal({ alphaxivAuth: null });
    throw new AlphaxivError('signed-out', errorMessage('signed-out'));
  }
  refreshing ??= (async () => {
    try {
      const reply = await postForm(ALPHAXIV_AUTH.token, {
        grant_type: 'refresh_token',
        refresh_token: alphaxivAuth.refreshToken,
        client_id: alphaxivAuth.clientId,
        resource: ALPHAXIV_MCP_URL,
      });
      const next = authFromTokenReply(reply, alphaxivAuth, Date.now());
      await setLocal({ alphaxivAuth: next });
      return next;
    } catch (e) {
      // Refused (not merely offline): the session is over; say so instead of retrying forever.
      if (e instanceof AlphaxivError && e.kind === 'signed-out') await setLocal({ alphaxivAuth: null });
      throw e;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/* ---------- MCP ---------- */

let session: { token: string; client: Client } | null = null;

async function connect(auth: AlphaxivAuth): Promise<Client> {
  if (session?.token === auth.accessToken) return session.client;
  await session?.client.close().catch(() => undefined);
  const client = new Client({ name: 'adhd-reader', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(ALPHAXIV_MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${auth.accessToken}` } },
  });
  await client.connect(transport);
  session = { token: auth.accessToken, client };
  return client;
}

function asAlphaxivError(e: unknown): AlphaxivError {
  if (e instanceof AlphaxivError) return e;
  if (e instanceof StreamableHTTPError && typeof e.code === 'number') return new AlphaxivError(kindForStatus(e.code), e.message);
  if (e instanceof TypeError || (typeof navigator !== 'undefined' && !navigator.onLine))
    return new AlphaxivError('offline', errorMessage('offline'));
  return new AlphaxivError('failed', e instanceof Error ? e.message : String(e));
}

/** Call one alphaXiv tool; its text reply. A 401 refreshes the token and retries once. */
export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const client = await connect(await currentAuth(attempt > 0));
      const result = (await client.callTool({ name, arguments: args })) as {
        content?: { type: string; text?: string }[];
        isError?: boolean;
      };
      const text = (result.content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
      if (result.isError) throw new AlphaxivError(/not found|no such|unknown paper/i.test(text) ? 'not-found' : 'failed', text || `${name} failed.`);
      return text;
    } catch (e) {
      const err = asAlphaxivError(e);
      session = null;
      if (err.kind === 'signed-out' && attempt === 0) continue;
      throw err;
    }
  }
}

/* ---------- Sync ---------- */

async function patchStatus(patch: Partial<{ email: string; lastSyncAt: number | null; error: string }>): Promise<void> {
  const { alphaxivStatus } = await getLocal('alphaxivStatus');
  await setLocal({ alphaxivStatus: { ...alphaxivStatus, ...patch } });
}

let syncing: Promise<{ ok: boolean; error?: string }> | null = null;

/**
 * Mirror the library onto the shelf, then drain the one-time push of papers
 * from before alphaXiv. Single-flight; without `force`, skipped when the last
 * sync was moments ago. Never throws: the outcome lands in alphaxivStatus.
 */
export function syncLibrary(force = false): Promise<{ ok: boolean; error?: string }> {
  syncing ??= (async () => {
    try {
      const { alphaxivAuth, alphaxivStatus } = await getLocal('alphaxivAuth', 'alphaxivStatus');
      if (!alphaxivAuth) return { ok: false, error: 'signed-out' };
      if (!force && alphaxivStatus.lastSyncAt && Date.now() - alphaxivStatus.lastSyncAt < SYNC_MIN_GAP_MS) return { ok: true };
      await pullLibrary();
      if (await pushQueued()) await pullLibrary();
      await patchStatus({ lastSyncAt: Date.now(), error: '' });
      return { ok: true };
    } catch (e) {
      const err = asAlphaxivError(e);
      await patchStatus({ error: err.kind === 'failed' ? err.message : errorMessage(err.kind) });
      return { ok: false, error: err.kind };
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

async function pullLibrary(): Promise<void> {
  const library = parseLibrary(await callTool('list_library', { include_papers: true }));
  // Read the shelf after the network call: the reader may have saved progress meanwhile.
  const { papers } = await getLocal('papers');
  const next = mergeLibrary(papers, library, Date.now());
  await setLocal(next);
}

/** The v27 queue, saved into alphaXiv folders once. True when anything was written. */
async function pushQueued(): Promise<boolean> {
  const { alphaxivPush, folders, papers } = await getLocal('alphaxivPush', 'folders', 'papers');
  if (!alphaxivPush.length) return false;
  const plan = planPush(alphaxivPush, folders, papers);
  const ids = new Map(folders.map((f) => [folderKey(f.name), f.id]));
  for (const name of plan.create) {
    const id = parseFolderId(await callTool('create_folder', { name }));
    if (!id) throw new AlphaxivError('failed', `alphaXiv created "${name}" but did not say where.`);
    ids.set(folderKey(name), id);
  }
  for (const save of plan.saves)
    await callTool('save_papers_to_folder', { paper_ids_or_urls: save.ids, folder_id: ids.get(folderKey(save.folder)) });
  // Cleared only once every save landed; a failure above leaves the queue for the next sync.
  await setLocal({ alphaxivPush: [] });
  return plan.saves.length > 0;
}
