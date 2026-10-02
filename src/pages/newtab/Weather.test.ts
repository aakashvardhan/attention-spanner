import { describe, expect, it } from 'vitest';
import { isStale, weatherLabel } from './Weather';

describe('weatherLabel', () => {
  it('names each WMO family at its boundaries', () => {
    expect(weatherLabel(0)).toBe('Clear');
    expect(weatherLabel(1)).toBe('Partly cloudy');
    expect(weatherLabel(2)).toBe('Partly cloudy');
    expect(weatherLabel(3)).toBe('Overcast');
    expect(weatherLabel(45)).toBe('Fog');
    expect(weatherLabel(48)).toBe('Fog');
    expect(weatherLabel(51)).toBe('Drizzle');
    expect(weatherLabel(57)).toBe('Drizzle');
    expect(weatherLabel(61)).toBe('Rain');
    expect(weatherLabel(67)).toBe('Rain');
    expect(weatherLabel(71)).toBe('Snow');
    expect(weatherLabel(77)).toBe('Snow');
    expect(weatherLabel(80)).toBe('Showers');
    expect(weatherLabel(82)).toBe('Showers');
    expect(weatherLabel(85)).toBe('Snow showers');
    expect(weatherLabel(86)).toBe('Snow showers');
    expect(weatherLabel(95)).toBe('Thunderstorm');
    expect(weatherLabel(99)).toBe('Thunderstorm');
  });

  it('refuses to name a code outside the table', () => {
    // This asserted 'Thunderstorm' first, which was the bug rather than the
    // contract — the ladder's final branch was catching everything unknown.
    // See the unusable-code cases in edgeCases.test.ts.
    expect(weatherLabel(200)).toBe('Unknown');
  });
});

describe('isStale', () => {
  const now = 1_757_900_000_000;

  it('is fresh inside the half hour', () => {
    expect(isStale(now - 29 * 60 * 1000, now)).toBe(false);
  });

  it('is stale at the half hour and past it', () => {
    expect(isStale(now - 30 * 60 * 1000, now)).toBe(true);
    expect(isStale(now - 5 * 60 * 60 * 1000, now)).toBe(true);
  });

  it('treats a never-fetched reading as stale', () => {
    expect(isStale(0, now)).toBe(true);
  });
});
