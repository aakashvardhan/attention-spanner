import { CALENDAR_DEFAULTS, hasCalendarCredentials, type CalendarState } from '../shared/calendar';
import { CALENDAR_EXPIRY_SKEW_MS, CALENDAR_SCOPE } from '../shared/constants';
import { emailFromIdToken } from '../shared/oauth';
import { getLocal, setLocal } from '../shared/storage';
import { authorize, refreshTokens, revoke, type GoogleTokens } from './googleOAuth';

/**
 * Google Calendar OAuth. The client belongs to the user, not to this build:
 * they create one in their own Cloud project and paste the id and secret into
 * Settings, so no one's calendar depends on the maintainer's project staying
 * healthy (docs/google-calendar-setup.md).
 *
 * The flow itself — PKCE, launchWebAuthFlow, the token endpoint — lives in
 * googleOAuth.ts and is shared with Gmail. What stays here is the mapping onto
 * this connector's single stored connection.
 */

export const AUTH_ERROR_HINT = 'Reconnect Google Calendar in Settings.';
export const NOT_CONFIGURED_HINT =
  'Add your Google OAuth client id and secret in Settings — see docs/google-calendar-setup.md.';
export const NOT_CONNECTED_HINT = 'Google Calendar is not connected — connect it in Settings.';

/** Read-modify-write one slice of the connection state. */
async function patchState(patch: Partial<CalendarState>): Promise<void> {
  const { calendar } = await getLocal('calendar');
  await setLocal({ calendar: { ...calendar, ...patch } });
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

/** Fold a token response into storage. Returns the fresh access token. */
async function storeTokens(json: GoogleTokens, keepRefresh: string): Promise<string> {
  if (!json.access_token) throw new Error('Google did not return an access token.');
  await patchState({
    connected: true,
    accessToken: json.access_token,
    // A refresh response omits refresh_token, meaning "keep using the old one"
    refreshToken: json.refresh_token ?? keepRefresh,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    lastError: '',
    ...(json.id_token ? { email: emailFromIdToken(json.id_token) } : {}),
  });
  return json.access_token;
}

export async function connect(): Promise<{ ok: boolean; email?: string; error?: string }> {
  try {
    const { calendar } = await getLocal('calendar');
    if (!hasCalendarCredentials(calendar)) throw new Error(NOT_CONFIGURED_HINT);

    const json = await authorize(calendar, CALENDAR_SCOPE);
    await storeTokens(json, '');
    const { calendar: fresh } = await getLocal('calendar');
    return { ok: true, email: fresh.email };
  } catch (err) {
    const message = (err as Error).message || 'Google sign-in failed.';
    await patchState({ lastError: message });
    return { ok: false, error: message };
  }
}

export async function disconnect(): Promise<{ ok: boolean }> {
  const { calendar } = await getLocal('calendar');
  // Revoking the refresh token drops the whole grant, so reconnecting shows
  // consent again instead of silently reusing it.
  await revoke(calendar.refreshToken || calendar.accessToken);
  // Keep the credentials — they're the user's OAuth client, not their session.
  await setLocal({
    calendar: {
      ...CALENDAR_DEFAULTS,
      clientId: calendar.clientId,
      clientSecret: calendar.clientSecret,
    },
  });
  return { ok: true };
}

/**
 * A usable access token, refreshing when it's within the skew of expiry. Same
 * policy as alphaxivAuth: a failed refresh means the grant is gone, so mark
 * disconnected and throw the reconnect hint rather than Google's wording.
 */
export async function getAccessToken(): Promise<string> {
  const { calendar } = await getLocal('calendar');
  if (!calendar.connected || !calendar.accessToken) throw new Error(NOT_CONNECTED_HINT);
  if (Date.now() < calendar.expiresAt - CALENDAR_EXPIRY_SKEW_MS) return calendar.accessToken;
  return refreshAccessToken();
}

/** Force a refresh — used on expiry and after a 401/403 from the API. */
export async function refreshAccessToken(): Promise<string> {
  const { calendar } = await getLocal('calendar');
  if (!calendar.refreshToken || !hasCalendarCredentials(calendar)) {
    await markDisconnected(AUTH_ERROR_HINT);
    throw new Error(AUTH_ERROR_HINT);
  }
  try {
    const json = await refreshTokens(calendar, calendar.refreshToken);
    return await storeTokens(json, calendar.refreshToken);
  } catch {
    await markDisconnected(AUTH_ERROR_HINT);
    throw new Error(AUTH_ERROR_HINT);
  }
}
