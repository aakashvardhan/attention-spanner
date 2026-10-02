/**
 * Edge cases for the new tab hero. The happy paths live in Hero.test.ts and
 * Weather.test.ts; this file is only the awkward inputs — bad clocks, missing
 * fields, malformed dates, and the values a hand-edited storage key can hold.
 */
import { describe, expect, it } from 'vitest';
import { greetingFor } from './Hero';
import { QUOTES, quoteOfDay } from './quotes';
import { isStale, usableReading, weatherLabel } from './Weather';

describe('quoteOfDay — bad dates', () => {
  it('still returns a quote for an unparseable date', () => {
    // localDate() cannot produce these, but a caller or a test can.
    expect(QUOTES).toContain(quoteOfDay('not-a-date'));
    expect(QUOTES).toContain(quoteOfDay(''));
  });

  it('is immune to daylight saving, which is why the date is parsed as UTC', () => {
    // US DST ends 2026-11-01. A local-midnight parse would make one of these
    // days 25 hours long and could repeat or skip a quote.
    const around = ['2026-10-31', '2026-11-01', '2026-11-02'];
    expect(new Set(around.map((d) => quoteOfDay(d))).size).toBe(3);
  });

  it('advances by exactly one across a year boundary', () => {
    const dec31 = QUOTES.indexOf(quoteOfDay('2026-12-31'));
    const jan01 = QUOTES.indexOf(quoteOfDay('2027-01-01'));
    expect(jan01).toBe((dec31 + 1) % QUOTES.length);
  });

  it('wraps cleanly at the end of the list rather than running off it', () => {
    // Walk a full cycle and confirm every quote is visited exactly once.
    const start = Date.parse('2026-01-01T00:00:00Z');
    const seen = new Set<string>();
    for (let day = 0; day < QUOTES.length; day++) {
      seen.add(quoteOfDay(new Date(start + day * 86_400_000).toISOString().slice(0, 10)));
    }
    expect(seen.size).toBe(QUOTES.length);
  });
});

describe('greetingFor — hours outside the clock', () => {
  it('never returns nothing, whatever the hour', () => {
    for (const hour of [-1, 0, 23, 24, 99]) {
      expect(greetingFor(hour)).toBeTruthy();
    }
  });
});

describe('weatherLabel — codes that are not in the table', () => {
  it('does not claim a thunderstorm when the code is missing or unusable', () => {
    // 99 is the last code in the WMO table, so anything past it is as much a
    // non-answer as a null is.
    for (const code of [NaN, undefined, null, -1, 100, 999] as number[]) {
      expect(weatherLabel(code)).toBe('Unknown');
    }
  });

  it('still reads a real high code as a thunderstorm', () => {
    expect(weatherLabel(95)).toBe('Thunderstorm');
    expect(weatherLabel(99)).toBe('Thunderstorm');
  });

  it('lands a fractional code in the bucket its ladder step covers', () => {
    expect(weatherLabel(61.5)).toBe('Rain');
  });
});

describe('usableReading — what the cache is allowed to put on screen', () => {
  const good = {
    query: 'San Jose',
    name: 'San Jose',
    lat: 37.3,
    lon: -121.9,
    tempC: 16.3,
    code: 0,
    fetchedAt: 1_757_900_000_000,
  };

  it('shows a reading that matches the city being asked for', () => {
    expect(usableReading(good, 'San Jose')).toBe(true);
  });

  it('hides a reading left over from a different city', () => {
    // The effect refetches, and until it lands the old city's temperature is
    // not an answer to the new city's question.
    expect(usableReading(good, 'Reykjavik')).toBe(false);
  });

  it('hides a reading with no temperature rather than printing 32°F', () => {
    // null * 9/5 + 32 === 32, so an unguarded render turns a missing value into
    // a confident freezing reading. Numbers that are not numbers say nothing.
    for (const tempC of [null, undefined, NaN, 'warm'] as number[]) {
      expect(usableReading({ ...good, tempC }, 'San Jose')).toBe(false);
    }
  });

  it('keeps a reading whose code is unusable — the temperature still is', () => {
    expect(usableReading({ ...good, code: -1 }, 'San Jose')).toBe(true);
  });

  it('hides everything when there is no reading or no city', () => {
    expect(usableReading(null, 'San Jose')).toBe(false);
    expect(usableReading(good, '')).toBe(false);
  });

  it('shows a stale reading — old weather beats an empty slot', () => {
    expect(usableReading({ ...good, fetchedAt: 0 }, 'San Jose')).toBe(true);
  });
});

describe('isStale — clocks that are wrong', () => {
  const now = 1_757_900_000_000;

  it('treats a reading from the future as stale, so skew cannot freeze it', () => {
    // A machine whose clock jumped forward and back would otherwise hold a
    // stale temperature until real time caught up with the bad timestamp.
    expect(isStale(now + 60 * 60 * 1000, now)).toBe(true);
  });

  it('is fresh for a reading taken this instant', () => {
    expect(isStale(now, now)).toBe(false);
  });
});
