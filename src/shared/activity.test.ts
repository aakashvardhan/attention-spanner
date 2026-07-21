import { describe, expect, it } from 'vitest';
import {
  activityLevel,
  buildActivityDays,
  dayActivityScore,
  formatDayTooltip,
  forwardMonthWindow,
  type DayActivityParts,
} from './activity';
import type { DayStats, SrsDayStats } from './types';

const ZERO: DayActivityParts = {
  minutes: 0,
  sprints: 0,
  articles: 0,
  videos: 0,
  focusBlocks: 0,
  gym: false,
  cardsReviewed: 0,
  tasks: 0,
};

describe('dayActivityScore', () => {
  it('scores each discrete signal at one point', () => {
    expect(dayActivityScore({ ...ZERO, tasks: 3 })).toBe(3);
    expect(dayActivityScore({ ...ZERO, articles: 1 })).toBe(1);
    expect(dayActivityScore({ ...ZERO, videos: 2 })).toBe(2);
    expect(dayActivityScore({ ...ZERO, sprints: 1 })).toBe(1);
    expect(dayActivityScore({ ...ZERO, focusBlocks: 2 })).toBe(2);
    expect(dayActivityScore({ ...ZERO, gym: true })).toBe(1);
  });

  it('normalizes minutes at 15 per point and reviews at 10 per point', () => {
    expect(dayActivityScore({ ...ZERO, minutes: 14 })).toBe(0);
    expect(dayActivityScore({ ...ZERO, minutes: 15 })).toBe(1);
    expect(dayActivityScore({ ...ZERO, minutes: 45 })).toBe(3);
    expect(dayActivityScore({ ...ZERO, cardsReviewed: 9 })).toBe(0);
    expect(dayActivityScore({ ...ZERO, cardsReviewed: 10 })).toBe(1);
  });

  it('sums a combined day', () => {
    expect(
      dayActivityScore({
        minutes: 30,
        sprints: 1,
        articles: 1,
        videos: 0,
        focusBlocks: 1,
        gym: true,
        cardsReviewed: 20,
        tasks: 3,
      }),
    ).toBe(2 + 1 + 1 + 1 + 1 + 2 + 3);
  });
});

describe('activityLevel', () => {
  it('keeps zero at zero, even with a nonzero max', () => {
    expect(activityLevel(0, 8)).toBe(0);
  });

  it('returns 0 for everything in an all-zero year', () => {
    expect(activityLevel(0, 0)).toBe(0);
  });

  it('buckets quartiles of the max', () => {
    expect(activityLevel(1, 8)).toBe(1);
    expect(activityLevel(2, 8)).toBe(1);
    expect(activityLevel(3, 8)).toBe(2);
    expect(activityLevel(4, 8)).toBe(2);
    expect(activityLevel(5, 8)).toBe(3);
    expect(activityLevel(6, 8)).toBe(3);
    expect(activityLevel(7, 8)).toBe(4);
    expect(activityLevel(8, 8)).toBe(4);
  });

  it('puts any nonzero score at max level when the max is 1', () => {
    expect(activityLevel(1, 1)).toBe(4);
  });
});

describe('formatDayTooltip', () => {
  const date = new Date(2026, 6, 6); // Mon, Jul 6 2026

  it('says No activity for an empty day', () => {
    expect(formatDayTooltip(date, ZERO, 0)).toBe('Mon, Jul 6 — No activity');
  });

  it('lists only nonzero parts with pluralization', () => {
    const parts: DayActivityParts = {
      ...ZERO,
      tasks: 1,
      minutes: 25.4,
      sprints: 2,
      gym: true,
      cardsReviewed: 12,
    };
    expect(formatDayTooltip(date, parts, dayActivityScore(parts))).toBe(
      'Mon, Jul 6 — 1 task · 25 min · 2 sprints · gym · 12 reviews',
    );
  });
});

describe('buildActivityDays', () => {
  const TODAY = '2026-07-06'; // a Monday
  const day = (over: Partial<DayStats> = {}): DayStats => ({
    minutes: 0,
    sprints: 0,
    articlesFinished: 0,
    ...over,
  });

  it('builds 53 Monday-start columns of 7 ending in today’s week', () => {
    const model = buildActivityDays({}, {}, {}, TODAY);
    expect(model.weeks).toHaveLength(53);
    expect(model.weeks.every((w) => w.length === 7)).toBe(true);
    const last = model.weeks[52];
    expect(last[0].date).toBe('2026-07-06'); // Monday of the current week
    expect(last[0].future).toBe(false); // today itself
    expect(last[1].future).toBe(true); // tomorrow onward hidden
    expect(last[6].future).toBe(true);
    const first = model.weeks[0];
    expect(first[0].date).toBe('2025-07-07'); // Monday 52 weeks (364 days) before
    expect(new Date(2025, 6, 7).getDay()).toBe(1); // …which is indeed a Monday
  });

  it('places scores on the right cells and aggregates totals', () => {
    const model = buildActivityDays(
      {
        '2026-07-06': day({ tasksCompleted: 2, minutes: 30 }), // today: 2 + 2
        '2026-06-30': day({ sprints: 1 }), // previous week, Tuesday
      },
      { '2026-07-06': Date.now() }, // gym today: +1
      { '2026-06-30': { reviews: { d1: 7, d2: 5 }, newIntroduced: {} } as SrsDayStats }, // +1
      TODAY,
    );
    const todayCell = model.weeks[52][0];
    expect(todayCell.score).toBe(5);
    const tuesday = model.weeks[51][1];
    expect(tuesday.date).toBe('2026-06-30');
    expect(tuesday.score).toBe(2); // 1 sprint + 12 reviews
    expect(model.maxScore).toBe(5);
    expect(model.totalActivities).toBe(7);
    expect(todayCell.level).toBe(4);
    expect(tuesday.level).toBe(2); // ceil(2/5*4) = 2
    expect(tuesday.tooltip).toContain('1 sprint');
    expect(tuesday.tooltip).toContain('12 reviews');
  });

  it('produces ~13 month labels in order without collisions', () => {
    const model = buildActivityDays({}, {}, {}, TODAY);
    const labels = model.monthLabels;
    expect(labels.length).toBeGreaterThanOrEqual(12);
    expect(labels.length).toBeLessThanOrEqual(13);
    for (let i = 1; i < labels.length; i++) {
      expect(labels[i].columnIndex - labels[i - 1].columnIndex).toBeGreaterThanOrEqual(3);
    }
    expect(labels[0].columnIndex).toBe(0);
  });

  it('an all-zero year yields level 0 everywhere and zero total', () => {
    const model = buildActivityDays({}, {}, {}, TODAY);
    expect(model.totalActivities).toBe(0);
    expect(model.weeks.flat().every((d) => d.level === 0)).toBe(true);
  });
});

describe('forwardMonthWindow', () => {
  const TODAY = '2026-07-06'; // a Monday

  it('starts at the Monday of the current month and spans three months', () => {
    const { startKey, weeks } = forwardMonthWindow(TODAY, 3);
    expect(startKey).toBe('2026-06-29'); // Monday of the week containing Jul 1
    expect(weeks).toBe(14); // through the Sunday after Sep 30

    const model = buildActivityDays({}, {}, {}, TODAY, weeks, startKey);
    expect(model.weeks).toHaveLength(14);
    expect(model.weeks[0][0].date).toBe('2026-06-29');
    expect(model.monthLabels.map((l) => l.label)).toEqual(['Jul', 'Aug', 'Sep']);
  });

  it('marks days after today as future and keeps today lit', () => {
    const { startKey, weeks } = forwardMonthWindow(TODAY, 3);
    const model = buildActivityDays({}, {}, {}, TODAY, weeks, startKey);
    const byDate = Object.fromEntries(model.weeks.flat().map((d) => [d.date, d]));
    expect(byDate[TODAY].future).toBe(false);
    expect(byDate['2026-07-07'].future).toBe(true);
    expect(byDate['2026-08-15'].future).toBe(true);
  });
});
