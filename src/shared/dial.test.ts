import { describe, expect, it } from 'vitest';
import { dialTime, litSegments, segmentCount } from './dial';

describe('segmentCount', () => {
  it('is one per minute up to an hour, then one per two minutes', () => {
    expect(segmentCount(10)).toBe(10);
    expect(segmentCount(50)).toBe(50);
    expect(segmentCount(60)).toBe(60);
    expect(segmentCount(90)).toBe(45);
    expect(segmentCount(25.5)).toBe(26);
  });
});

describe('litSegments', () => {
  const MIN = 60_000;
  it('lights one segment per finished step and never before it finishes', () => {
    expect(litSegments(0, 50 * MIN, 50)).toBe(0);
    expect(litSegments(MIN - 1, 50 * MIN, 50)).toBe(0);
    expect(litSegments(MIN, 50 * MIN, 50)).toBe(1);
    expect(litSegments(12.5 * MIN, 50 * MIN, 50)).toBe(12);
  });

  it('clamps outside the phase', () => {
    expect(litSegments(-5, 50 * MIN, 50)).toBe(0);
    expect(litSegments(80 * MIN, 50 * MIN, 50)).toBe(50);
    expect(litSegments(MIN, 0, 50)).toBe(0);
  });
});

describe('dialTime', () => {
  it('shows minutes in focus, rounding up so 38:12 left reads 39 min', () => {
    expect(dialTime(38 * 60 + 12, 'focus')).toEqual({ value: '39', unit: 'min' });
    expect(dialTime(61, 'focus')).toEqual({ value: '2', unit: 'min' });
  });

  it('brings seconds back for the last minute of focus, and always in a break', () => {
    expect(dialTime(60, 'focus')).toEqual({ value: '1:00', unit: null });
    expect(dialTime(42, 'focus')).toEqual({ value: '0:42', unit: null });
    expect(dialTime(9 * 60 + 5, 'break')).toEqual({ value: '9:05', unit: null });
  });
});
