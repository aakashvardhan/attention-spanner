import { describe, expect, it } from 'vitest';
import { countInWeek, nextDailyOccurrence, prevWeekKey, weekDates, weekKey } from './week';

describe('weekKey', () => {
  it('maps a Monday to itself', () => {
    expect(weekKey(new Date(2026, 5, 22))).toBe('2026-06-22'); // Mon Jun 22 2026
  });

  it('maps mid-week days to their Monday', () => {
    expect(weekKey(new Date(2026, 5, 24))).toBe('2026-06-22'); // Wed
    expect(weekKey(new Date(2026, 5, 27))).toBe('2026-06-22'); // Sat
  });

  it('maps Sunday to the PREVIOUS Monday', () => {
    expect(weekKey(new Date(2026, 5, 28))).toBe('2026-06-22'); // Sun Jun 28
  });

  it('handles year boundaries', () => {
    expect(weekKey(new Date(2026, 0, 1))).toBe('2025-12-29'); // Thu Jan 1 2026 → Mon Dec 29 2025
  });
});

describe('prevWeekKey', () => {
  it('steps back 7 days', () => {
    expect(prevWeekKey('2026-06-29')).toBe('2026-06-22');
  });

  it('crosses month and year edges', () => {
    expect(prevWeekKey('2026-07-06')).toBe('2026-06-29');
    expect(prevWeekKey('2026-01-05')).toBe('2025-12-29');
  });
});

describe('weekDates', () => {
  it('returns Mon..Sun', () => {
    const dates = weekDates('2026-06-22');
    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe('2026-06-22');
    expect(dates[6]).toBe('2026-06-28');
  });

  it('spans month boundaries', () => {
    const dates = weekDates('2026-06-29');
    expect(dates[2]).toBe('2026-07-01');
  });
});

describe('countInWeek', () => {
  it('counts only dates inside the week', () => {
    const checkins = {
      '2026-06-22': 1,
      '2026-06-25': 1,
      '2026-06-28': 1, // Sunday, same week
      '2026-06-29': 1, // next Monday — different week
    };
    expect(countInWeek(checkins, '2026-06-22')).toBe(3);
    expect(countInWeek(checkins, '2026-06-29')).toBe(1);
  });
});

describe('nextDailyOccurrence', () => {
  it('returns today when the time is still ahead', () => {
    const now = new Date(2026, 6, 3, 12, 0);
    const next = new Date(nextDailyOccurrence('18:00', now));
    expect(next.getDate()).toBe(3);
    expect(next.getHours()).toBe(18);
  });

  it('rolls to tomorrow when the time has passed', () => {
    const now = new Date(2026, 6, 3, 19, 30);
    const next = new Date(nextDailyOccurrence('18:00', now));
    expect(next.getDate()).toBe(4);
    expect(next.getHours()).toBe(18);
    expect(next.getMinutes()).toBe(0);
  });
});
