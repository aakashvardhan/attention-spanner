import {
  FETCH_TIMEOUT_MS,
  GOOGLE_AUTH_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
} from '../shared/constants';
import { randomUrlSafe, s256Challenge } from '../shared/oauth';

/**
 * The Google authorization-code + PKCE flow, once, for the connectors that run
 * it (Calendar, Gmail).
 *
 * Why not chrome.identity.getAuthToken: it reads a client id from the manifest
 * and requires the extension id to match the client's registered item id, so
 * every clone of this repo would share one Cloud project as a single point of
 * failure. launchWebAuthFlow has none of that — the redirect URL is this
 * install's own https://<extension-id>.chromiumapp.org/, which the user
 * registers on their own client.
 *
 * Google issues a secret for a Web application client and wants it at the
 * token endpoint even alongside PKCE. It is the user's own and never leaves
 * this device, but it's why Settings asks for two values rather than one.
 *
 * Storage-agnostic on purpose: each connector owns the shape it persists
 * tokens into (one CalendarState, or one of several GmailAccounts).
 */

export interface GoogleTokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  /** Space-separated scopes actually granted — not necessarily those requested */
  scope?: string;
}

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

async function postToken(body: Record<string, string>): Promise<GoogleTokens> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => null)) as
      | (GoogleTokens & { error?: string; error_description?: string })
      | null;
    if (!res.ok) {
      // Google's own wording is the diagnostic here — `invalid_client` means the
      // pasted id/secret don't match, `invalid_grant` means the grant is gone,
      // `admin_policy_enforced` means a Workspace admin blocked the app.
      const detail = json?.error_description ?? json?.error ?? '';
      throw new Error(
        `Google rejected the token request (HTTP ${res.status}${detail ? `: ${detail}` : ''}).`,
      );
    }
    if (!json) throw new Error('Google returned an unreadable token response.');
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the interactive sign-in and exchange the code for tokens.
 *
 * `prompt` defaults to 'consent'. Without both that and access_type=offline
 * Google returns an access token and no refresh token, and the connection
 * would quietly die an hour later; 'consent' also re-mints the refresh token
 * after a revoke. Pass 'consent select_account' when connecting an additional
 * account, or Google silently reuses the browser's current session instead of
 * showing the chooser.
 */
export async function authorize(
  client: GoogleClient,
  scope: string,
  prompt = 'consent',
): Promise<GoogleTokens> {
  const verifier = randomUrlSafe(32);
  const state = randomUrlSafe(16);
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl =
    `${GOOGLE_AUTH_URL}?` +
    new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      access_type: 'offline',
      prompt,
      state,
      code_challenge: await s256Challenge(verifier),
      code_challenge_method: 'S256',
    }).toString();

  const redirect = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  if (!redirect) throw new Error('Sign-in was cancelled.');

  const params = new URL(redirect).searchParams;
  const error = params.get('error');
  if (error) throw new Error(`Google declined the sign-in (${error}).`);
  if (params.get('state') !== state) throw new Error('Sign-in response did not match the request.');
  const code = params.get('code');
  if (!code) throw new Error('Google did not return an authorization code.');

  return postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code_verifier: verifier,
  });
}

export async function refreshTokens(
  client: GoogleClient,
  refreshToken: string,
): Promise<GoogleTokens> {
  return postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
}

/**
 * Revoke a grant. Best-effort: a token Google has already forgotten is not an
 * error the user needs to hear about, and the local state is cleared either way.
 */
export async function revoke(token: string): Promise<void> {
  if (!token) return;
  await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
    method: 'POST',
  }).catch(() => undefined);
}
