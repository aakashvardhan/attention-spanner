import {
  CALENDAR_API_BASE,
  CALENDAR_REFRESH_THROTTLE_MS,
} from '../shared/constants';
import {
  CALENDAR_DEFAULTS,
  mapApiEvent,
  mapApiEvents,
  type CalendarEvent,
} from '../shared/calendar';
import { getLocal, getSettings, setLocal } from '../shared/storage';
import type { FocusSession } from '../shared/types';

/**
 * Google Calendar IO — auth via chrome.identity.getAuthToken (Chrome mints and
 * silently refreshes tokens for the signed-in profile; no refresh-token
 * plumbing). Primary calendar only. State lives in LocalSchema.calendar;
 * pure mapping/agenda logic in src/shared/calendar.ts.
 */

const AUTH_ERROR_HINT = 'Reconnect Google Calendar in Settings.';

function isConfigured(): boolean {
  return Boolean(chrome.runtime.getManifest().oauth2?.client_id);
}

async function getToken(interactive: boolean): Promise<string> {
  const result = await chrome.identity.getAuthToken({ interactive });
  const token = typeof result === 'string' ? result : result?.token;
  if (!token) throw new Error('Google sign-in did not return a token');
  return token;
}

async function markDisconnected(error: string): Promise<void> {
  const { calendar } = await getLocal('calendar');
  await setLocal({ calendar: { ...calendar, connected: false, lastError: error } });
}

/**
 * Authed fetch with the standard expiry policy: on 401/403 drop the cached
 * token, silently re-acquire, retry once; a second failure means access was
 * revoked → mark disconnected. A failed non-interactive token grab ("OAuth2
 * not granted or revoked") means the same thing — surface the reconnect hint,
 * never Chrome's raw error.
 */
async function apiFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const attempt = async (token: string) =>
    fetch(`${CALENDAR_API_BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

  const silentToken = async (): Promise<string> => {
    try {
      return await getToken(false);
    } catch {
      await markDisconnected(AUTH_ERROR_HINT);
      throw new Error(AUTH_ERROR_HINT);
    }
  };

  let token = await silentToken();
  let res = await attempt(token);
  if (res.status === 401 || res.status === 403) {
    await chrome.identity.removeCachedAuthToken({ token });
    token = await silentToken();
    res = await attempt(token);
  }
  if (res.status === 401 || res.status === 403) {
    await markDisconnected(AUTH_ERROR_HINT);
    throw new Error(AUTH_ERROR_HINT);
  }
  if (!res.ok) throw new Error(`Calendar API error (HTTP ${res.status})`);
  return res.status === 204 ? null : res.json();
}

export async function calSignIn(): Promise<{ ok: boolean; email?: string; error?: string }> {
  if (!isConfigured()) {
    return { ok: false, error: 'Calendar OAuth is not configured — see docs/google-calendar-setup.md.' };
  }
  try {
    await getToken(true); // interactive consent
    let email = '';
    try {
      const info = await chrome.identity.getProfileUserInfo({
        accountStatus: 'ANY' as chrome.identity.AccountStatus,
      });
      email = info.email;
    } catch {
      // display-only; fine without it
    }
    const { calendar } = await getLocal('calendar');
    await setLocal({ calendar: { ...calendar, connected: true, email, lastError: '' } });
    await refreshCalendar(true);
    return { ok: true, email };
  } catch (error) {
    return { ok: false, error: (error as Error).message ?? 'Google sign-in failed.' };
  }
}

export async function calSignOut(): Promise<{ ok: boolean }> {
  try {
    const token = await getToken(false);
    // Best-effort: revoke the grant so re-connecting shows consent again
    await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(token)}`).catch(
      () => undefined,
    );
    await chrome.identity.removeCachedAuthToken({ token });
  } catch {
    // No cached token — nothing to revoke
  }
  await setLocal({ calendar: { ...CALENDAR_DEFAULTS } });
  return { ok: true };
}

/**
 * Pull the [local today 00:00, +48h) window from the primary calendar.
 * No-ops when unconfigured/disconnected, and throttles unforced calls so a
 * newtab-open refresh can't hammer the API.
 */
export async function refreshCalendar(force = false): Promise<{ ok: boolean; error?: string }> {
  if (!isConfigured()) return { ok: true };
  const { calendar } = await getLocal('calendar');
  if (!calendar.connected) return { ok: true };
  if (!force && Date.now() - calendar.fetchedAt < CALENDAR_REFRESH_THROTTLE_MS) {
    return { ok: true };
  }

  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const timeMin = dayStart.toISOString();
  const timeMax = new Date(dayStart.getTime() + 48 * 60 * 60 * 1000).toISOString();

  try {
    const json = (await apiFetch(
      '/calendars/primary/events?' +
        new URLSearchParams({
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '50',
          timeMin,
          timeMax,
        }).toString(),
    )) as { items?: unknown[] };
    const events = mapApiEvents(json.items ?? []);
    const { calendar: latest } = await getLocal('calendar');
    await setLocal({
      calendar: { ...latest, events, fetchedAt: Date.now(), lastError: '' },
    });
    return { ok: true };
  } catch (error) {
    const message = (error as Error).message ?? 'Calendar refresh failed.';
    const { calendar: latest } = await getLocal('calendar');
    await setLocal({ calendar: { ...latest, lastError: message } });
    return { ok: false, error: message };
  }
}

/* Focus time-blocking. Every function here is fire-and-forget from focus.ts —
   errors are swallowed so a calendar hiccup can never break a focus session. */

const FOCUS_BLOCK_TITLE = '🎯 Focus';
const FOCUS_BLOCK_MIN_MS = 2 * 60_000;

/** Create the "🎯 Focus" event for a just-started session */
export async function createFocusBlock(session: FocusSession): Promise<void> {
  try {
    const settings = await getSettings();
    const { calendar } = await getLocal('calendar');
    if (!settings.focusCalendarBlockEnabled || !isConfigured() || !calendar.connected) return;

    const json = await apiFetch('/calendars/primary/events', {
      method: 'POST',
      body: JSON.stringify({
        summary: FOCUS_BLOCK_TITLE,
        start: { dateTime: new Date(session.startedAt).toISOString() },
        end: { dateTime: new Date(session.phaseEndsAt).toISOString() },
      }),
    });
    const event = mapApiEvent(json);
    if (!event) return;

    // Only attach the id if this exact session is still the live one
    const { focusSession } = await getLocal('focusSession');
    if (focusSession && focusSession.startedAt === session.startedAt) {
      await setLocal({ focusSession: { ...focusSession, calendarEventId: event.id } });
    }
  } catch (error) {
    console.warn('[calendar] focus block create failed:', error);
  }
}

/** Manual/early stop: trim the event to reality, or delete a sub-2-min stub */
export async function finishFocusBlock(
  eventId: string,
  startedAt: number,
  plannedEndMs: number,
): Promise<void> {
  try {
    const now = Date.now();
    if (now >= plannedEndMs) return; // ran its course — the event is already accurate
    if (now - startedAt < FOCUS_BLOCK_MIN_MS) {
      await apiFetch(`/calendars/primary/events/${encodeURIComponent(eventId)}`, {
        method: 'DELETE',
      });
    } else {
      await apiFetch(`/calendars/primary/events/${encodeURIComponent(eventId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ end: { dateTime: new Date(now).toISOString() } }),
      });
    }
    void refreshCalendar(true);
  } catch (error) {
    console.warn('[calendar] focus block finish failed:', error);
  }
}

/** Pomodoro break→focus: stretch the single session event to the new phase end */
export async function extendFocusBlock(eventId: string, endMs: number): Promise<void> {
  try {
    await apiFetch(`/calendars/primary/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ end: { dateTime: new Date(endMs).toISOString() } }),
    });
  } catch (error) {
    console.warn('[calendar] focus block extend failed:', error);
  }
}

/**
 * Events overlapping [startMs, endMs), for the assistant's list_events tool.
 * Served from the cached 48h window when the range fits (after a throttled
 * refresh); arbitrary dates outside it hit the API directly.
 */
export async function listEvents(
  startMs: number,
  endMs: number,
): Promise<{ ok: boolean; events?: CalendarEvent[]; error?: string }> {
  const { calendar } = await getLocal('calendar');
  if (!isConfigured() || !calendar.connected) {
    return { ok: false, error: 'Google Calendar is not connected — connect it in Settings.' };
  }
  await refreshCalendar();

  const { calendar: fresh } = await getLocal('calendar');
  if (!fresh.connected) {
    return { ok: false, error: AUTH_ERROR_HINT };
  }
  const fetched = new Date(fresh.fetchedAt);
  const windowStart = new Date(fetched.getFullYear(), fetched.getMonth(), fetched.getDate()).getTime();
  const windowEnd = windowStart + 48 * 60 * 60 * 1000;
  if (fresh.fetchedAt > 0 && startMs >= windowStart && endMs <= windowEnd) {
    return { ok: true, events: fresh.events.filter((e) => e.startMs < endMs && e.endMs > startMs) };
  }

  try {
    const json = (await apiFetch(
      '/calendars/primary/events?' +
        new URLSearchParams({
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '50',
          timeMin: new Date(startMs).toISOString(),
          timeMax: new Date(endMs).toISOString(),
        }).toString(),
    )) as { items?: unknown[] };
    return { ok: true, events: mapApiEvents(json.items ?? []) };
  } catch (error) {
    return { ok: false, error: (error as Error).message ?? 'Could not fetch events.' };
  }
}

export async function createCalendarEvent(
  title: string,
  startMs: number,
  endMs: number,
): Promise<{ ok: boolean; event?: CalendarEvent; error?: string }> {
  const { calendar } = await getLocal('calendar');
  if (!isConfigured() || !calendar.connected) {
    return { ok: false, error: 'Google Calendar is not connected — connect it in Settings.' };
  }
  try {
    const json = await apiFetch('/calendars/primary/events', {
      method: 'POST',
      body: JSON.stringify({
        summary: title,
        start: { dateTime: new Date(startMs).toISOString() },
        end: { dateTime: new Date(endMs).toISOString() },
      }),
    });
    const event = mapApiEvent(json);
    void refreshCalendar(true); // pull the authoritative window so the card updates
    return event ? { ok: true, event } : { ok: false, error: 'Calendar returned an odd event.' };
  } catch (error) {
    return { ok: false, error: (error as Error).message ?? 'Could not create the event.' };
  }
}
