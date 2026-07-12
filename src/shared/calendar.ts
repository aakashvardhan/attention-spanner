import { localDate } from './format';

/**
 * Google Calendar — pure types and logic (API-JSON mapping, agenda math,
 * event-time parsing). All IO lives in src/background/calendar.ts, mirroring
 * the notion.ts split. Every function takes `now` so it's unit-testable.
 */

export interface CalendarEvent {
  id: string;
  title: string;
  /** All-day events carry local-midnight bounds */
  startMs: number;
  endMs: number;
  allDay: boolean;
  /** '' when absent */
  location: string;
  htmlLink: string;
  hangoutLink: string;
}

/** → LocalSchema.calendar. Device-local; never synced to Firestore. */
export interface CalendarState {
  connected: boolean;
  email: string;
  /** Sorted by startMs; window [local today 00:00, +48h) */
  events: CalendarEvent[];
  fetchedAt: number;
  /** '' = healthy */
  lastError: string;
}

export const CALENDAR_DEFAULTS: CalendarState = {
  connected: false,
  email: '',
  events: [],
  fetchedAt: 0,
  lastError: '',
};

interface ApiEventTime {
  dateTime?: string;
  /** All-day events use 'YYYY-MM-DD' */
  date?: string;
}

interface ApiEvent {
  id?: string;
  status?: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: ApiEventTime;
  end?: ApiEventTime;
}

/** 'YYYY-MM-DD' as LOCAL midnight — Date.parse would read it as UTC and shift the day */
function parseLocalDate(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function parseEventTime(t: ApiEventTime | undefined): { ms: number; allDay: boolean } | null {
  if (t?.dateTime) {
    const ms = Date.parse(t.dateTime); // RFC3339 with offset — safe to parse
    return Number.isNaN(ms) ? null : { ms, allDay: false };
  }
  if (t?.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date)) {
    return { ms: parseLocalDate(t.date), allDay: true };
  }
  return null;
}

/** Map one events.list item; null = skip (cancelled or unparsable) */
export function mapApiEvent(raw: unknown): CalendarEvent | null {
  const event = raw as ApiEvent;
  if (!event || typeof event !== 'object' || !event.id) return null;
  if (event.status === 'cancelled') return null;
  const start = parseEventTime(event.start);
  const end = parseEventTime(event.end);
  if (!start || !end) return null;
  return {
    id: event.id,
    title: (event.summary ?? '').trim() || '(untitled)',
    startMs: start.ms,
    endMs: end.ms,
    allDay: start.allDay,
    location: event.location ?? '',
    htmlLink: event.htmlLink ?? '',
    hangoutLink: event.hangoutLink ?? '',
  };
}

export function mapApiEvents(items: unknown[]): CalendarEvent[] {
  return items
    .map(mapApiEvent)
    .filter((e): e is CalendarEvent => e !== null)
    .sort((a, b) => a.startMs - b.startMs);
}

/** Events overlapping the local calendar day of `now` */
export function todayEvents(events: CalendarEvent[], now: Date): CalendarEvent[] {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  return events.filter((e) => e.startMs < dayEnd && e.endMs > dayStart);
}

/** Timed event currently in progress (all-day events never count) */
export function currentEvent(events: CalendarEvent[], now: Date): CalendarEvent | null {
  const t = now.getTime();
  return events.find((e) => !e.allDay && e.startMs <= t && e.endMs > t) ?? null;
}

/** Next timed event that hasn't started yet */
export function nextUpcoming(
  events: CalendarEvent[],
  now: Date,
): { event: CalendarEvent; minutesUntil: number } | null {
  const t = now.getTime();
  const next = events.find((e) => !e.allDay && e.startMs > t);
  if (!next) return null;
  return { event: next, minutesUntil: Math.ceil((next.startMs - t) / 60000) };
}

export function formatCountdown(minutesUntil: number): string {
  if (minutesUntil <= 0) return 'now';
  if (minutesUntil < 60) return `in ${minutesUntil}m`;
  const h = Math.floor(minutesUntil / 60);
  const m = minutesUntil % 60;
  return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
}

/** 'HH:MM' 24h → minutes since midnight, or null */
function parseHhmm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

export const EVENT_MIN_MINUTES = 5;
export const EVENT_MAX_MINUTES = 720;

/**
 * Validate/convert the assistant's create_event params into ms bounds.
 * Local wall-clock semantics; date defaults to today, duration to 60 min.
 */
export function parseEventTimes(
  params: { date?: string; startTime: string; durationMinutes?: number },
  now: Date,
): { ok: true; startMs: number; endMs: number } | { ok: false; error: string } {
  const minutes = parseHhmm(params.startTime);
  if (minutes === null) {
    return { ok: false, error: `start time should be HH:MM (24h), got “${params.startTime}”` };
  }
  const ymd = params.date?.trim() || localDate(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    return { ok: false, error: `date should be YYYY-MM-DD, got “${params.date}”` };
  }
  const duration = Math.min(
    EVENT_MAX_MINUTES,
    Math.max(EVENT_MIN_MINUTES, Math.round(params.durationMinutes ?? 60)),
  );
  const startMs = parseLocalDate(ymd) + minutes * 60000;
  return { ok: true, startMs, endMs: startMs + duration * 60000 };
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Compact lines for the assistant data context / briefing (max 6 events) */
export function calendarContextLines(events: CalendarEvent[], now: Date): string[] {
  const today = todayEvents(events, now);
  if (today.length === 0) return ['Calendar today: no events.'];

  const parts = today.slice(0, 6).map((e) => {
    if (e.allDay) return `${e.title} (all day)`;
    return `${hhmm(e.startMs)}–${hhmm(e.endMs)} ${e.title}`;
  });
  const lines = [
    `Calendar today (${today.length} event${today.length === 1 ? '' : 's'}): ${parts.join('; ')}.`,
  ];
  const next = nextUpcoming(today, now);
  if (next) lines.push(`Next: ${next.event.title} ${formatCountdown(next.minutesUntil)}.`);
  return lines;
}
