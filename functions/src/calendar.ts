/**
 * Events go straight to Google Calendar with a server-side OAuth refresh
 * token. The extension treats GCal as source of truth (device-local via
 * chrome.identity, re-fetched every 15 minutes), so a bot-created event
 * appears in the extension — and on the phone's calendar — with zero
 * extension changes. A synced `events` collection would have made a second
 * source of truth; this doesn't.
 */

export interface CalendarEnv {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function calendarConfigured(env: CalendarEnv): boolean {
  return Boolean(env.clientId && env.clientSecret && env.refreshToken);
}

async function accessToken(env: CalendarEnv): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      refresh_token: env.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed (${res.status})`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('Google token refresh returned no access token');
  return data.access_token;
}

/** Create a 1-hour event on the primary calendar; returns a short confirmation */
export async function createEvent(
  env: CalendarEnv,
  args: { title: string; date: string | null; time: string; timeZone: string },
): Promise<string> {
  const [h, m] = args.time.split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h > 23 || m > 59) {
    throw new Error(`Bad time "${args.time}" — use HH:MM, 24-hour.`);
  }
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  const start = `${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  const endMinutes = h * 60 + m + 60;
  const end = `${date}T${String(Math.floor(endMinutes / 60) % 24).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}:00`;

  const token = await accessToken(env);
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: args.title,
      start: { dateTime: start, timeZone: args.timeZone },
      end: { dateTime: end, timeZone: args.timeZone },
    }),
  });
  if (!res.ok) throw new Error(`Calendar insert failed (${res.status})`);
  return `Added: ${args.title} on ${date} at ${args.time}`;
}
