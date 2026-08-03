import { describe, expect, it } from 'vitest';
import { buildPrimeTime, hoursFromTimestamps, MIN_POINTS } from './primeTime';
import type { DayStats } from './types';

function day(hours: Record<string, number>): DayStats {
  return { minutes: 0, sprints: 0, articlesFinished: 0, hours };
}

/** `count` consecutive Mondays (2026-07-06 is a Monday), each with the same hours */
function mondays(count: number, hours: Record<string, number>): Record<string, DayStats> {
  const out: Record<string, DayStats> = {};
  for (let i = 0; i < count; i++) {
    out[`2026-07-${String(6 + i * 7).padStart(2, '0')}`] = day(hours);
  }
  return out;
}

/** Enough points to clear the gate, concentrated in the given hours */
function loadedEvenings(hours: number[], perHour = 5): Record<string, DayStats> {
  const buckets: Record<string, number> = {};
  for (const h of hours) buckets[String(h)] = perHour;
  return mondays(6, buckets);
}

describe('hoursFromTimestamps', () => {
  it('buckets timestamps by local date and hour, one point each', () => {
    const out = hoursFromTimestamps([
      new Date(2026, 6, 6, 21, 5).getTime(),
      new Date(2026, 6, 6, 21, 55).getTime(),
      new Date(2026, 6, 6, 9, 30).getTime(),
      new Date(2026, 6, 7, 21, 0).getTime(),
    ]);
    expect(out).toEqual({
      '2026-07-06': { '21': 2, '9': 1 },
      '2026-07-07': { '21': 1 },
    });
  });

  it('drops nulls, zeros and non-finite values', () => {
    // completedAt is null on open tasks; 0 is the v6 updatedAt backfill default
    expect(hoursFromTimestamps([0, NaN, Infinity, undefined as unknown as number])).toEqual({});
  });
});

describe('buildPrimeTime', () => {
  it('renders an empty 7x24 grid with no claims for no data', () => {
    const model = buildPrimeTime({}, new Date(2026, 6, 21, 22));
    expect(model.grid).toHaveLength(7);
    expect(model.grid[0]).toHaveLength(24);
    expect(model.totalPoints).toBe(0);
    expect(model.peak).toBeNull();
    expect(model.dead).toBeNull();
    expect(model.nowRank).toBeNull();
    expect(model.headline).toContain('Learning your rhythm');
  });

  it('buckets points by weekday and hour', () => {
    // 2026-07-06 is a Monday, 2026-07-11 the Saturday of that week
    const model = buildPrimeTime(
      { '2026-07-06': day({ '21': 3 }), '2026-07-11': day({ '14': 2 }) },
      new Date(2026, 6, 21, 22),
    );
    expect(model.grid[0][21].points).toBe(3);
    expect(model.grid[5][14].points).toBe(2);
    expect(model.hourProfile[21]).toBe(3);
    expect(model.totalPoints).toBe(5);
  });

  it('withholds peak and dead until the sample clears minPoints', () => {
    const justUnder = buildPrimeTime(mondays(1, { '21': MIN_POINTS - 1 }), new Date(2026, 6, 21, 22));
    expect(justUnder.peak).toBeNull();
    expect(justUnder.headline).toContain('Learning your rhythm');

    const atGate = buildPrimeTime(mondays(1, { '21': MIN_POINTS }), new Date(2026, 6, 21, 22));
    expect(atGate.peak).not.toBeNull();
  });

  it('finds the peak window and labels it', () => {
    const model = buildPrimeTime(loadedEvenings([20, 21, 22]), new Date(2026, 6, 21, 15));
    expect(model.peak).toEqual({ startHour: 20, endHour: 23, label: '8-11pm' });
  });

  it('finds a peak window that wraps past midnight', () => {
    const model = buildPrimeTime(loadedEvenings([22, 23, 0]), new Date(2026, 6, 21, 15));
    expect(model.peak?.startHour).toBe(22);
    expect(model.peak?.label).toBe('10pm-1am');
  });

  it('keeps the dead zone inside waking hours', () => {
    // Nights are empty, but 3am must never be reported as the dead zone
    const model = buildPrimeTime(loadedEvenings([9, 10, 20, 21, 22]), new Date(2026, 6, 21, 15));
    expect(model.dead!.startHour).toBeGreaterThanOrEqual(6);
    expect(model.dead!.endHour).toBeLessThanOrEqual(22);
  });

  it('ranks the current hour against the pooled profile', () => {
    const daily = mondays(6, { '21': 10, '20': 8, '14': 2 });
    expect(buildPrimeTime(daily, new Date(2026, 6, 21, 21)).nowRank).toBe(1);
    expect(buildPrimeTime(daily, new Date(2026, 6, 21, 20)).nowRank).toBe(2);
    // An hour that has never seen activity has no meaningful rank
    expect(buildPrimeTime(daily, new Date(2026, 6, 21, 3)).nowRank).toBeNull();
  });

  it('tells the user to start when the current hour is one of their best', () => {
    const model = buildPrimeTime(mondays(6, { '21': 10, '20': 8 }), new Date(2026, 6, 21, 21));
    expect(model.headline).toBe("You're in your best hour. Start the hard thing.");
  });

  it('names the dead zone when the current hour sits in it', () => {
    const model = buildPrimeTime(loadedEvenings([20, 21, 22]), new Date(2026, 6, 21, 7));
    expect(model.headline).toBe('This is your dead zone. Do admin, not deep work.');
  });

  it('counts down to the peak window from an ordinary hour', () => {
    const daily = mondays(6, { '20': 10, '21': 10, '22': 10, '17': 1 });
    const model = buildPrimeTime(daily, new Date(2026, 6, 21, 17));
    expect(model.headline).toBe('Peak is 8-11pm. 3 hours out.');
  });

  it('scales levels against the busiest cell', () => {
    const model = buildPrimeTime(
      { '2026-07-06': day({ '21': 12, '9': 3, '14': 0 }) },
      new Date(2026, 6, 21, 22),
    );
    expect(model.grid[0][21].level).toBe(4);
    expect(model.grid[0][9].level).toBe(1);
    expect(model.grid[0][14].level).toBe(0);
  });

  it('ignores malformed hour keys', () => {
    const model = buildPrimeTime(
      { '2026-07-06': day({ '25': 5, '-1': 5, 'x': 5, '21': 2 }) },
      new Date(2026, 6, 21, 22),
    );
    expect(model.totalPoints).toBe(2);
  });

  it('reads a seeded ledger the same as a live one', () => {
    // 20 evenings of two events each clears the gate and names the window
    const stamps: number[] = [];
    for (let d = 0; d < 20; d++) {
      stamps.push(new Date(2026, 5, 1 + d, 21, 15).getTime());
      stamps.push(new Date(2026, 5, 1 + d, 22, 40).getTime());
    }
    const seeded = hoursFromTimestamps(stamps);
    const daily = Object.fromEntries(
      Object.entries(seeded).map(([date, hours]) => [date, day(hours)]),
    );
    const model = buildPrimeTime(daily, new Date(2026, 6, 21, 15));
    expect(model.totalPoints).toBe(40);
    // 8-11pm and 9pm-12am both cover the two loaded hours; ties take the earlier start
    expect(model.peak?.label).toBe('8-11pm');
  });

  it('writes a readable tooltip per cell', () => {
    const model = buildPrimeTime({ '2026-07-06': day({ '21': 1 }) }, new Date(2026, 6, 21, 22));
    expect(model.grid[0][21].tooltip).toBe('Mon 9-10pm — 1 activity');
    expect(model.grid[2][8].tooltip).toBe('Wed 8-9am — Nothing');
  });
});
