import { ALPHAXIV_DEFAULTS, type AlphaxivState } from '../shared/alphaxiv';
import {
  ALPHAXIV_API_HOST,
  ALPHAXIV_AUTH_BASE,
  ALPHAXIV_DNR_RULE_ID,
  ALPHAXIV_EXPIRY_SKEW_MS,
  ALPHAXIV_MCP_URL,
  ALPHAXIV_SCOPE,
  ALPHAXIV_TRUSTED_ORIGIN,
  FETCH_TIMEOUT_MS,
} from '../shared/constants';
import { emailFromIdToken, randomUrlSafe, s256Challenge } from '../shared/oauth';
import { getLocal, setLocal } from '../shared/storage';

/**
 * alphaXiv OAuth. Unlike Google Calendar (chrome.identity.getAuthToken, which
 * needs a client id baked into the manifest and a stable extension id), alphaXiv
 * runs an OAuth 2.1 server with open dynamic client registration: we register
 * ourselves at first connect with whatever redirect URL this install has, so
 * there is nothing to configure per build. Public client + PKCE — no secret.
 */

export const AUTH_ERROR_HINT = 'Reconnect alphaXiv in Settings.';

const REGISTER_URL = `${ALPHAXIV_AUTH_BASE}/oauth2/register`;
const AUTHORIZE_URL = `${ALPHAXIV_AUTH_BASE}/oauth2/authorize`;
const TOKEN_URL = `${ALPHAXIV_AUTH_BASE}/oauth2/token`;

/**
 * Chrome puts `Origin: chrome-extension://<id>` on every POST from the service
 * worker, and alphaXiv's auth server refuses the token exchange with
 * "Invalid origin" when it sees it — it wants the origin of the client's
 * registered redirect URL (`https://<id>.chromiumapp.org`). `Origin` is a
 * forbidden header, so fetch() cannot drop it; declarativeNetRequest can.
 *
 * Rewriting it is the fix, not removing it. Dropping the header makes Chrome
 * send `Origin: null`, and the server answers `403 MISSING_OR_NULL_ORIGIN` —
 * it tolerates a request with no `Origin` at all (curl), but not a null one,
 * and an extension fetch can never be the former.
 *
 * The value has to be alphaXiv's own web origin. The redirect URL's origin
 * (`https://<id>.chromiumapp.org`) is what the server's wording implies it
 * wants, and `/oauth2/register` does accept it, but the token endpoint answers
 * `403 Invalid origin` — its trusted list is just the first-party site. So this
 * presents as their web app. That is a workaround for an auth server with no
 * story for non-browser clients, not something to copy elsewhere: nothing here
 * rides on a cookie, the token exchange is bound to this client by PKCE, and
 * the header is the only part being borrowed.
 *
 * Dynamic rules persist across service-worker restarts and browser restarts, so
 * the promise here is only to keep repeat calls from rewriting the same rule.
 */
let originRuleReady: Promise<void> | null = null;

export function ensureOriginRule(): Promise<void> {
  originRuleReady ??= chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ALPHAXIV_DNR_RULE_ID],
    addRules: [
      {
        id: ALPHAXIV_DNR_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: [
            {
              header: 'origin',
              operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
              value: ALPHAXIV_TRUSTED_ORIGIN,
            },
          ],
        },
        condition: {
          requestDomains: [ALPHAXIV_API_HOST],
          resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType],
        },
      },
    ],
  });
  return originRuleReady;
}

/** Read-modify-write one slice of the connection state. */
async function patchState(patch: Partial<AlphaxivState>): Promise<void> {
  const { alphaxiv } = await getLocal('alphaxiv');
  await setLocal({ alphaxiv: { ...alphaxiv, ...patch } });
}

export async function markDisconnected(error: string): Promise<void> {
  await patchState({
    connected: false,
    accessToken: '',
    refreshToken: '',
    expiresAt: 0,
    lastError: error,
  });
}

async function postForm(url: string, body: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: controller.signal,
    });
    // Read as text first: a rejection worth debugging is exactly the one whose
    // body doesn't parse or doesn't use the field we expected. `error_description`
    // is the OAuth field, `message` is what this server sends for its own checks
    // (it runs better-auth), and the raw body is the last resort — a bare
    // "HTTP 403" told us nothing and cost a round of guessing.
    const text = await res.text();
    const json: unknown = (() => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    })();
    if (!res.ok) {
      const fields = (json ?? {}) as { error_description?: unknown; message?: unknown };
      const detail =
        typeof fields.error_description === 'string'
          ? fields.error_description
          : typeof fields.message === 'string'
            ? fields.message
            : text.slice(0, 200).trim();
      throw new Error(
        `alphaXiv rejected the sign-in (HTTP ${res.status}${detail ? `: ${detail}` : ''}).`,
      );
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Register this install as an OAuth client and return the id. Cached in
 * storage: the redirect URL is per-install, so the registration is too.
 */
async function registerClient(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const redirectUri = chrome.identity.getRedirectURL();
  try {
    const res = await fetch(REGISTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        client_name: 'Reader (Chrome extension)',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: ALPHAXIV_SCOPE,
      }),
    });
    const json = (await res.json().catch(() => null)) as
      | { client_id?: string; message?: string; error_description?: string }
      | null;
    if (res.ok && json?.client_id) return json.client_id;

    // Registration is rate-limited per IP (a few per window), which is a wait,
    // not a misconfiguration — worth calling out separately.
    if (res.status === 429) {
      throw new Error('alphaXiv is rate-limiting sign-ups right now. Wait a minute and try again.');
    }
    // Anything else: report what the server actually said, plus the redirect
    // URL we asked it to trust — that's the only input it can object to, and
    // it's invisible from outside the browser. Guessing at the cause here once
    // produced a confidently wrong "registration is closed".
    const detail = json?.message ?? json?.error_description ?? '';
    throw new Error(
      `alphaXiv refused to register this extension (HTTP ${res.status}` +
        `${detail ? `: ${detail}` : ''}). Redirect URL sent: ${redirectUri}. ` +
        'If it keeps refusing, mint a client id by hand and paste it below — see ' +
        'docs/alphaxiv-setup.md.',
    );
  } finally {
    clearTimeout(timer);
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

/** Fold a token response into storage. Returns the fresh access token. */
async function storeTokens(json: TokenResponse, keepRefresh: string): Promise<string> {
  if (!json.access_token) throw new Error('alphaXiv did not return an access token.');
  await patchState({
    connected: true,
    accessToken: json.access_token,
    // A refresh response may omit refresh_token, meaning "keep using the old one"
    refreshToken: json.refresh_token ?? keepRefresh,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    lastError: '',
    ...(json.id_token ? { email: emailFromIdToken(json.id_token) } : {}),
  });
  return json.access_token;
}

/**
 * Where to actually point the sign-in window. Handing it the authorize URL
 * dead-ends: that endpoint 302s to `/signin?<signed query>` whenever it cannot
 * see a session cookie, and the auth window never carries one, so alphaXiv's
 * `/signin` route then bounces an already-signed-in user to the app root and
 * the OAuth request is dropped with no error at all — the window just sits on
 * the Explore feed until it is closed.
 *
 * Following the redirect here and swapping `/signin` for `/oauth/consent` skips
 * that. The consent page takes the same signed query, and it runs first-party
 * on www.alphaxiv.org where the session does resolve. If alphaXiv ever routes
 * an authorized request straight to consent, the replace is a no-op.
 */
async function consentUrl(authUrl: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(authUrl, { signal: controller.signal });
    const landed = new URL(res.url);
    // A rejected request (unknown client, bad redirect_uri) lands on the auth
    // server's error page instead. Say so here rather than showing the user a
    // browser window that looks like the app and does nothing.
    const error = landed.searchParams.get('error');
    if (error) {
      const detail = landed.searchParams.get('error_description') ?? '';
      throw new Error(`alphaXiv declined the sign-in (${error}${detail ? `: ${detail}` : ''}).`);
    }
    return res.url.replace('/signin?', '/oauth/consent?');
  } finally {
    clearTimeout(timer);
  }
}

export async function connect(): Promise<{ ok: boolean; email?: string; error?: string }> {
  try {
    await ensureOriginRule();
    const { alphaxiv } = await getLocal('alphaxiv');
    const clientId = alphaxiv.clientId || (await registerClient());
    if (clientId !== alphaxiv.clientId) await patchState({ clientId });

    const verifier = randomUrlSafe(32);
    const state = randomUrlSafe(16);
    const redirectUri = chrome.identity.getRedirectURL();
    const authUrl =
      `${AUTHORIZE_URL}?` +
      new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: ALPHAXIV_SCOPE,
        state,
        code_challenge: await s256Challenge(verifier),
        code_challenge_method: 'S256',
        // RFC 8707 — MCP servers scope the token to the protected resource
        resource: ALPHAXIV_MCP_URL,
      }).toString();

    const redirect = await chrome.identity.launchWebAuthFlow({
      url: await consentUrl(authUrl),
      interactive: true,
    });
    if (!redirect) throw new Error('Sign-in was cancelled.');

    const params = new URL(redirect).searchParams;
    const error = params.get('error');
    if (error) throw new Error(`alphaXiv declined the sign-in (${error}).`);
    if (params.get('state') !== state) throw new Error('Sign-in response did not match the request.');
    const code = params.get('code');
    if (!code) throw new Error('alphaXiv did not return an authorization code.');

    const json = (await postForm(TOKEN_URL, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: ALPHAXIV_MCP_URL,
    })) as TokenResponse;

    await storeTokens(json, '');
    const { alphaxiv: fresh } = await getLocal('alphaxiv');
    return { ok: true, email: fresh.email };
  } catch (err) {
    const message = (err as Error).message || 'alphaXiv sign-in failed.';
    await patchState({ lastError: message });
    return { ok: false, error: message };
  }
}

export async function disconnect(): Promise<{ ok: boolean }> {
  const { alphaxiv } = await getLocal('alphaxiv');
  // Keep the client registration (it's tied to this install's redirect URL, not
  // to the account) so reconnecting doesn't register a second client.
  await setLocal({ alphaxiv: { ...ALPHAXIV_DEFAULTS, clientId: alphaxiv.clientId } });
  return { ok: true };
}

/**
 * A usable access token, refreshing when it's within the skew of expiry. A
 * failed refresh means the grant is gone: mark disconnected and throw the
 * reconnect hint rather than the server's wording (same policy as calendar.ts).
 */
export async function getAccessToken(): Promise<string> {
  // Before the connected check: every MCP call funnels through here, so this is
  // what keeps the rule in place for an install that connected before it existed.
  await ensureOriginRule();
  const { alphaxiv } = await getLocal('alphaxiv');
  if (!alphaxiv.connected || !alphaxiv.accessToken) {
    throw new Error('alphaXiv is not connected — connect it in Settings.');
  }
  if (Date.now() < alphaxiv.expiresAt - ALPHAXIV_EXPIRY_SKEW_MS) return alphaxiv.accessToken;
  return refreshAccessToken();
}

/** Force a refresh — used on expiry and after a 401 from the MCP endpoint. */
export async function refreshAccessToken(): Promise<string> {
  const { alphaxiv } = await getLocal('alphaxiv');
  if (!alphaxiv.refreshToken || !alphaxiv.clientId) {
    await markDisconnected(AUTH_ERROR_HINT);
    throw new Error(AUTH_ERROR_HINT);
  }
  try {
    const json = (await postForm(TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: alphaxiv.refreshToken,
      client_id: alphaxiv.clientId,
      resource: ALPHAXIV_MCP_URL,
    })) as TokenResponse;
    return await storeTokens(json, alphaxiv.refreshToken);
  } catch {
    await markDisconnected(AUTH_ERROR_HINT);
    throw new Error(AUTH_ERROR_HINT);
  }
}
