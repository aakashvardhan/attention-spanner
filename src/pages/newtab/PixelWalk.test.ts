import { describe, expect, it } from 'vitest';
import { skyFor } from './PixelWalk';

describe('skyFor', () => {
  it('draws the weather the readout names', () => {
    expect(skyFor(0)).toBe('clear');
    expect(skyFor(2)).toBe('cloudy');
    expect(skyFor(3)).toBe('cloudy');
    expect(skyFor(45)).toBe('fog');
    expect(skyFor(53)).toBe('rain');
    expect(skyFor(63)).toBe('rain');
    expect(skyFor(81)).toBe('rain');
    expect(skyFor(73)).toBe('snow');
    expect(skyFor(86)).toBe('snow');
    expect(skyFor(95)).toBe('storm');
  });

  it('draws no sun for a code it cannot read', () => {
    expect(skyFor(-1)).toBe('calm');
    expect(skyFor(200)).toBe('calm');
  });
});
