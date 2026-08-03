import {
  CALENDAR_API_BASE,
  CALENDAR_REFRESH_THROTTLE_MS,
} from '../shared/constants';
import { mapApiEvent, mapApiEvents, type CalendarEvent } from '../shared/calendar';
import { getLocal, getSettings, setLocal } from '../shared/storage';
import type { FocusSession } from '../shared/types';
import {
  AUTH_ERROR_HINT,
  NOT_CONNECTED_HINT,
  connect,
  disconnect,
  getAccessToken,
  markDisconnected,
  refreshAccessToken,
} from './calendarAuth';

/**
 * Google Calendar IO — primary calendar only. Auth (the user's own OAuth client,
 * PKCE, token refresh) lives in calendarAuth.ts; state in LocalSchema.calendar;
 * pure mapping/agenda logic in src/shared/calendar.ts.
 */

/**
 * Authed fetch with the standard expiry policy: on 401/403 force a refresh and
 * retry once; a second failure means access was revoked → mark disconnected and
 * surface the reconnect hint rather than Google's raw error.
 */
async function apiFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const attempt = async (token: string) =>
    fetch(`${CALENDAR_API_BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

  let res = await attempt(await getAccessToken());
  if (res.status === 401 || res.status === 403) {
    res = await attempt(await refreshAccessToken());
  }
  if (res.status === 401 || res.status === 403) {
    await markDisconnected(AUTH_ERROR_HINT);
    throw new Error(AUTH_ERROR_HINT);
  }
  if (!res.ok) throw new Error(`Calendar API error (HTTP ${res.status})`);
  return res.status === 204 ? null : res.json();
}

export async function calSignIn(): Promise<{ ok: boolean; email?: string; error?: string }> {
  const result = await connect();
  if (result.ok) await refreshCalendar(true);
  return result;
}

export async function calSignOut(): Promise<{ ok: boolean }> {
  return disconnect();
}

/**
 * Pull the [local today 00:00, +48h) window from the primary calendar.
 * No-ops while disconnected, and throttles unforced calls so a newtab-open
 * refresh can't hammer the API.
 */
export async function refreshCalendar(force = false): Promise<{ ok: boolean; error?: string }> {
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

const FOCUS_BLOCK_TITLE = 'Focus';
const FOCUS_BLOCK_MIN_MS = 2 * 60_000;

/** Create the "Focus" event for a just-started session */
export async function createFocusBlock(session: FocusSession): Promise<void> {
  try {
    const settings = await getSettings();
    const { calendar } = await getLocal('calendar');
    if (!settings.focusCalendarBlockEnabled || !calendar.connected) return;

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
  if (!calendar.connected) return { ok: false, error: NOT_CONNECTED_HINT };
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
  if (!calendar.connected) return { ok: false, error: NOT_CONNECTED_HINT };
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
