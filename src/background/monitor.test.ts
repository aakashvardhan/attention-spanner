import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../shared/calendar';
import { MONITOR_CARDS_DUE_MIN } from '../shared/constants';
import type { FlashCard } from '../shared/types';
import { inQuietHours } from '../shared/week';
import { buildEveningNudge, pickEventToNotify, type EveningNudgeData } from './monitor';

const NOW = new Date(2026, 6, 11, 19, 0, 0); // Sat Jul 11 2026, 19:00 local

function data(): EveningNudgeData {
  return {
    streaks: { currentStreak: 0, longestStreak: 0, lastQualifiedDate: '', daily: {}, freezeTokens: 0 },
    flashCards: [],
    srsDaily: {},
  };
}

function dueCard(id: string): FlashCard {
  return {
    id: `${id}#0`,
    noteId: id,
    deckId: 'd1',
    variant: 0,
    phase: 'review',
    stepIndex: 0,
    ease: 2.5,
    intervalDays: 3,
    dueAt: NOW.getTime() - 1000,
    lapses: 0,
    reps: 4,
    createdAt: 0,
  };
}

function ev(id: string, startsInMin: number, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  const startMs = NOW.getTime() + startsInMin * 60_000;
  return {
    id,
    title: 'Design review',
    startMs,
    endMs: startMs + 30 * 60_000,
    allDay: false,
    location: '',
    htmlLink: '',
    hangoutLink: '',
    ...overrides,
  };
}

describe('inQuietHours', () => {
  const at = (h: number, m = 0) => new Date(2026, 6, 11, h, m);

  it('handles a same-day window', () => {
    expect(inQuietHours('09:00', '17:00', at(12))).toBe(true);
    expect(inQuietHours('09:00', '17:00', at(8, 59))).toBe(false);
    expect(inQuietHours('09:00', '17:00', at(17, 0))).toBe(false); // end exclusive
    expect(inQuietHours('09:00', '17:00', at(9, 0))).toBe(true); // start inclusive
  });

  it('wraps overnight', () => {
    expect(inQuietHours('22:00', '08:00', at(23))).toBe(true);
    expect(inQuietHours('22:00', '08:00', at(3))).toBe(true);
    expect(inQuietHours('22:00', '08:00', at(12))).toBe(false);
    expect(inQuietHours('22:00', '08:00', at(8, 0))).toBe(false);
  });

  it('is never quiet on equal bounds or junk', () => {
    expect(inQuietHours('10:00', '10:00', at(10))).toBe(false);
    expect(inQuietHours('junk', '08:00', at(3))).toBe(false);
  });
});

describe('buildEveningNudge', () => {
  it('returns null when nothing needs saying', () => {
    expect(buildEveningNudge(data(), NOW)).toBeNull();
  });

  it('flags a streak at risk only when today is empty', () => {
    const d = data();
    d.streaks.currentStreak = 6;
    expect(buildEveningNudge(d, NOW)!.message).toContain('6-day reading streak ends tonight');

    d.streaks.daily['2026-07-11'] = { minutes: 10, sprints: 0, articlesFinished: 0 };
    expect(buildEveningNudge(d, NOW)).toBeNull();
  });

  it('flags cards only at or above the threshold', () => {
    const d = data();
    d.flashCards = Array.from({ length: MONITOR_CARDS_DUE_MIN - 1 }, (_, i) => dueCard(`n${i}`));
    expect(buildEveningNudge(d, NOW)).toBeNull();

    d.flashCards = Array.from({ length: MONITOR_CARDS_DUE_MIN }, (_, i) => dueCard(`n${i}`));
    expect(buildEveningNudge(d, NOW)!.message).toContain(`${MONITOR_CARDS_DUE_MIN} flashcards are due`);
  });

  it('combines both conditions into one message', () => {
    const d = data();
    d.streaks.currentStreak = 3;
    d.flashCards = Array.from({ length: 12 }, (_, i) => dueCard(`n${i}`));
    const nudge = buildEveningNudge(d, NOW)!;
    expect(nudge.message).toContain('streak');
    expect(nudge.message).toContain('12 flashcards');
  });
});

describe('pickEventToNotify', () => {
  it('picks a timed event inside the window', () => {
    const hit = pickEventToNotify([ev('e1', 10)], [], NOW);
    expect(hit!.event.id).toBe('e1');
    expect(hit!.minutesUntil).toBe(10);
  });

  it('ignores events outside the window', () => {
    expect(pickEventToNotify([ev('e1', 30)], [], NOW)).toBeNull();
    expect(pickEventToNotify([ev('e1', -5)], [], NOW)).toBeNull();
  });

  it('skips already-notified and all-day events', () => {
    expect(pickEventToNotify([ev('e1', 10)], ['e1'], NOW)).toBeNull();
    expect(pickEventToNotify([ev('e2', 10, { allDay: true })], [], NOW)).toBeNull();
  });
});
