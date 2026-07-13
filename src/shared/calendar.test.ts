import { describe, expect, it } from 'vitest';
import {
  calendarContextLines,
  currentEvent,
  dayRange,
  formatCountdown,
  formatEventList,
  mapApiEvent,
  mapApiEvents,
  nextUpcoming,
  parseEventTimes,
  todayEvents,
  type CalendarEvent,
} from './calendar';

// Sat Jul 11 2026, 09:00 local
const NOW = new Date(2026, 6, 11, 9, 0, 0);

function ev(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'x',
    title: 'Event',
    startMs: NOW.getTime(),
    endMs: NOW.getTime() + 3600_000,
    allDay: false,
    location: '',
    htmlLink: '',
    hangoutLink: '',
    ...overrides,
  };
}

const at = (h: number, m = 0, day = 11) => new Date(2026, 6, day, h, m).getTime();

describe('mapApiEvent', () => {
  it('maps a timed event', () => {
    const mapped = mapApiEvent({
      id: 'e1',
      summary: 'Standup',
      start: { dateTime: '2026-07-11T10:00:00-07:00' },
      end: { dateTime: '2026-07-11T10:30:00-07:00' },
      location: 'Zoom',
      htmlLink: 'https://cal',
      hangoutLink: 'https://meet',
    });
    expect(mapped).toMatchObject({
      id: 'e1',
      title: 'Standup',
      allDay: false,
      location: 'Zoom',
      hangoutLink: 'https://meet',
    });
    expect(mapped!.endMs - mapped!.startMs).toBe(30 * 60000);
  });

  it('parses all-day dates as LOCAL midnight (not UTC)', () => {
    const mapped = mapApiEvent({
      id: 'e2',
      summary: 'Conference',
      start: { date: '2026-07-11' },
      end: { date: '2026-07-12' },
    });
    expect(mapped!.allDay).toBe(true);
    expect(mapped!.startMs).toBe(new Date(2026, 6, 11).getTime());
    expect(mapped!.endMs).toBe(new Date(2026, 6, 12).getTime());
  });

  it('skips cancelled and unparsable events, falls back on titles', () => {
    expect(mapApiEvent({ id: 'e', status: 'cancelled', start: { date: '2026-07-11' } })).toBeNull();
    expect(mapApiEvent({ id: 'e', start: { dateTime: 'garbage' } })).toBeNull();
    expect(mapApiEvent({ summary: 'no id' })).toBeNull();
    expect(mapApiEvent(null)).toBeNull();
    const untitled = mapApiEvent({
      id: 'e',
      start: { dateTime: '2026-07-11T10:00:00Z' },
      end: { dateTime: '2026-07-11T11:00:00Z' },
    });
    expect(untitled!.title).toBe('(untitled)');
  });

  it('mapApiEvents sorts by start', () => {
    const events = mapApiEvents([
      { id: 'b', start: { dateTime: '2026-07-11T14:00:00Z' }, end: { dateTime: '2026-07-11T15:00:00Z' } },
      { id: 'a', start: { dateTime: '2026-07-11T10:00:00Z' }, end: { dateTime: '2026-07-11T11:00:00Z' } },
      'junk',
    ]);
    expect(events.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('agenda math', () => {
  const events = [
    ev({ id: 'allday', allDay: true, startMs: at(0), endMs: at(0, 0, 12) }),
    ev({ id: 'past', startMs: at(7), endMs: at(8) }),
    ev({ id: 'current', startMs: at(8, 30), endMs: at(9, 30) }),
    ev({ id: 'next', startMs: at(9, 25), endMs: at(10) }),
    ev({ id: 'tomorrow', startMs: at(9, 0, 12), endMs: at(10, 0, 12) }),
  ];

  it('todayEvents keeps events overlapping the local day', () => {
    expect(todayEvents(events, NOW).map((e) => e.id)).toEqual([
      'allday',
      'past',
      'current',
      'next',
    ]);
  });

  it('currentEvent finds the in-progress timed event, never all-day', () => {
    expect(currentEvent(events, NOW)?.id).toBe('current');
    expect(currentEvent([events[0]], NOW)).toBeNull();
  });

  it('nextUpcoming skips in-progress and all-day events', () => {
    const next = nextUpcoming(events, NOW);
    expect(next?.event.id).toBe('next');
    expect(next?.minutesUntil).toBe(25);
  });

  it('nextUpcoming returns null when nothing is ahead', () => {
    expect(nextUpcoming([events[1]], NOW)).toBeNull();
  });
});

describe('formatCountdown', () => {
  it('formats boundaries', () => {
    expect(formatCountdown(0)).toBe('now');
    expect(formatCountdown(25)).toBe('in 25m');
    expect(formatCountdown(60)).toBe('in 1h');
    expect(formatCountdown(70)).toBe('in 1h 10m');
  });
});

describe('parseEventTimes', () => {
  it('defaults date to today and duration to 60', () => {
    const res = parseEventTimes({ startTime: '14:00' }, NOW);
    expect(res).toEqual({ ok: true, startMs: at(14), endMs: at(15) });
  });

  it('honors explicit date and duration, clamping extremes', () => {
    const res = parseEventTimes(
      { startTime: '9:30', date: '2026-07-12', durationMinutes: 1 },
      NOW,
    );
    expect(res).toEqual({
      ok: true,
      startMs: at(9, 30, 12),
      endMs: at(9, 35, 12), // clamped up to 5 min
    });
  });

  it('rejects bad times and dates', () => {
    expect(parseEventTimes({ startTime: '2pm' }, NOW).ok).toBe(false);
    expect(parseEventTimes({ startTime: '25:00' }, NOW).ok).toBe(false);
    expect(parseEventTimes({ startTime: '14:00', date: 'tomorrow' }, NOW).ok).toBe(false);
  });
});

describe('calendarContextLines', () => {
  it('summarizes the day with a next-event line', () => {
    const lines = calendarContextLines(
      [
        ev({ id: 'a', title: 'Standup', startMs: at(10), endMs: at(10, 30) }),
        ev({ id: 'b', title: 'Focus day', allDay: true, startMs: at(0), endMs: at(0, 0, 12) }),
      ],
      NOW,
    );
    expect(lines[0]).toContain('2 events');
    expect(lines[0]).toContain('10:00–10:30 Standup');
    expect(lines[0]).toContain('Focus day (all day)');
    expect(lines[1]).toBe('Next: Standup in 1h.');
  });

  it('says so when the day is empty', () => {
    expect(calendarContextLines([], NOW)).toEqual(['Calendar today: no events.']);
  });
});

describe('dayRange', () => {
  const dayStart = at(0);
  const DAY = 24 * 60 * 60 * 1000;

  it('defaults to today for empty/omitted input', () => {
    expect(dayRange(undefined, NOW)).toEqual({ startMs: dayStart, endMs: dayStart + DAY, label: 'today' });
    expect(dayRange('  ', NOW)).toEqual({ startMs: dayStart, endMs: dayStart + DAY, label: 'today' });
    expect(dayRange('Today', NOW)).toEqual({ startMs: dayStart, endMs: dayStart + DAY, label: 'today' });
  });

  it('handles tomorrow', () => {
    expect(dayRange('tomorrow', NOW)).toEqual({
      startMs: dayStart + DAY,
      endMs: dayStart + 2 * DAY,
      label: 'tomorrow',
    });
  });

  it('parses explicit dates as local days with a readable label', () => {
    const range = dayRange('2026-07-17', NOW);
    expect(range).not.toBeNull();
    expect(range!.startMs).toBe(new Date(2026, 6, 17).getTime());
    expect(range!.endMs - range!.startMs).toBe(DAY);
    expect(range!.label).toContain('Jul 17');
  });

  it('rejects junk', () => {
    expect(dayRange('next tuesday', NOW)).toBeNull();
    expect(dayRange('07/17/2026', NOW)).toBeNull();
  });
});

describe('formatEventList', () => {
  it('lists timed, all-day, and located events', () => {
    const out = formatEventList(
      [
        ev({ id: 'a', title: 'Standup', startMs: at(10), endMs: at(10, 30), location: 'Zoom' }),
        ev({ id: 'b', title: 'Conference', allDay: true }),
      ],
      'tomorrow',
    );
    expect(out).toContain('2 events tomorrow:');
    expect(out).toContain('• 10:00–10:30 — Standup (Zoom)');
    expect(out).toContain('• all day — Conference');
  });

  it('phrases empty days by label type', () => {
    expect(formatEventList([], 'today')).toBe('No events today. 🎉');
    expect(formatEventList([], 'Fri, Jul 17')).toBe('No events on Fri, Jul 17. 🎉');
  });
});
