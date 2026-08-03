import { CALENDAR_EXPIRY_SKEW_MS, GMAIL_SCOPE } from '../shared/constants';
import {
  hasGmailCredentials,
  missingScopes,
  upsertAccount,
  type GmailAccount,
  type GmailState,
} from '../shared/gmail';
import { emailFromIdToken } from '../shared/oauth';
import { getLocal, setLocal } from '../shared/storage';
import { authorize, refreshTokens, revoke } from './googleOAuth';

/**
 * Gmail OAuth, one grant per connected account. Same user-owned client and
 * same PKCE flow as Calendar (googleOAuth.ts); what differs is that there are
 * several connections instead of one, so every operation names an account.
 *
 * Two things worth knowing about Gmail specifically, both documented in
 * docs/gmail-setup.md:
 *  - its scopes are *restricted*, so a Cloud project left in "Testing"
 *    publishing status expires refresh tokens after seven days;
 *  - a Workspace tenant can refuse the app outright
 *    (`admin_policy_enforced`), which is why the failure is stored per account
 *    rather than on the connector.
 */

export const AUTH_ERROR_HINT = 'Reconnect this account in Settings.';
export const NOT_CONFIGURED_HINT =
  'Add your Google OAuth client id and secret in Settings — see docs/gmail-setup.md.';

async function patchState(patch: Partial<GmailState>): Promise<void> {
  const { gmail } = await getLocal('gmail');
  await setLocal({ gmail: { ...gmail, ...patch } });
}

async function patchAccount(id: string, patch: Partial<GmailAccount>): Promise<void> {
  const { gmail } = await getLocal('gmail');
  await setLocal({
    gmail: {
      ...gmail,
      accounts: gmail.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    },
  });
}

/**
 * Record a problem against an account without touching its tokens. For
 * everything that is wrong with the *project* or the *consent screen* rather
 * than the grant — the grant still works and throwing it away would only cost
 * the user a reconnect they don't need.
 */
export async function noteAccountError(id: string, error: string): Promise<void> {
  await patchAccount(id, { lastError: error });
}

export async function markAccountDisconnected(id: string, error: string): Promise<void> {
  await patchAccount(id, {
    connected: false,
    accessToken: '',
    refreshToken: '',
    expiresAt: 0,
    lastError: error,
  });
}

/**
 * Connect a mailbox. `select_account` rather than plain consent, because with
 * one account already connected Google would otherwise reuse the browser's
 * current session and silently re-authorize the same mailbox.
 */
export async function connect(): Promise<{ ok: boolean; email?: string; error?: string }> {
  try {
    const { gmail } = await getLocal('gmail');
    if (!hasGmailCredentials(gmail)) throw new Error(NOT_CONFIGURED_HINT);

    const prompt = gmail.accounts.length > 0 ? 'consent select_account' : 'consent';
    const json = await authorize(gmail, GMAIL_SCOPE, prompt);
    if (!json.access_token) throw new Error('Google did not return an access token.');
    if (!json.refresh_token) {
      throw new Error('Google did not return a refresh token — remove the app from your Google account permissions and reconnect.');
    }
    // Fail here, where the cause is obvious, rather than on the first fetch
    const missing = missingScopes(json.scope);
    if (missing.length > 0) {
      throw new Error(
        `Google granted the sign-in but not ${missing.join(' or ')}. Add those scopes to your OAuth consent screen (APIs & Services → OAuth consent screen → Scopes), then connect again.`,
      );
    }

    const account: GmailAccount = {
      id: crypto.randomUUID(),
      email: emailFromIdToken(json.id_token),
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      connected: true,
      lastError: '',
    };

    const { gmail: fresh } = await getLocal('gmail');
    await setLocal({
      gmail: { ...fresh, accounts: upsertAccount(fresh.accounts, account), lastError: '' },
    });
    return { ok: true, email: account.email };
  } catch (err) {
    const message = (err as Error).message || 'Google sign-in failed.';
    await patchState({ lastError: message });
    return { ok: false, error: message };
  }
}

/** Revoke and forget one account. The shared client credentials stay. */
export async function disconnect(id: string): Promise<{ ok: boolean }> {
  const { gmail } = await getLocal('gmail');
  const account = gmail.accounts.find((a) => a.id === id);
  if (!account) return { ok: true };

  await revoke(account.refreshToken || account.accessToken);
  await setLocal({
    gmail: {
      ...gmail,
      accounts: gmail.accounts.filter((a) => a.id !== id),
      // Triaged mail from a mailbox we no longer read has nowhere to act
      triaged: gmail.triaged.filter((m) => m.accountId !== id),
    },
  });
  return { ok: true };
}

export async function getAccessToken(id: string): Promise<string> {
  const { gmail } = await getLocal('gmail');
  const account = gmail.accounts.find((a) => a.id === id);
  if (!account?.connected || !account.accessToken) {
    throw new Error('That mailbox is not connected — connect it in Settings.');
  }
  if (Date.now() < account.expiresAt - CALENDAR_EXPIRY_SKEW_MS) return account.accessToken;
  return refreshAccessToken(id);
}

/** Force a refresh — on expiry and after a 401/403 from the API. */
export async function refreshAccessToken(id: string): Promise<string> {
  const { gmail } = await getLocal('gmail');
  const account = gmail.accounts.find((a) => a.id === id);
  if (!account?.refreshToken || !hasGmailCredentials(gmail)) {
    await markAccountDisconnected(id, AUTH_ERROR_HINT);
    throw new Error(AUTH_ERROR_HINT);
  }
  try {
    const json = await refreshTokens(gmail, account.refreshToken);
    if (!json.access_token) throw new Error('no access token');
    await patchAccount(id, {
      connected: true,
      accessToken: json.access_token,
      // A refresh response omits refresh_token, meaning "keep using the old one"
      refreshToken: json.refresh_token ?? account.refreshToken,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      lastError: '',
    });
    return json.access_token;
  } catch {
    await markAccountDisconnected(id, AUTH_ERROR_HINT);
    throw new Error(AUTH_ERROR_HINT);
  }
}
