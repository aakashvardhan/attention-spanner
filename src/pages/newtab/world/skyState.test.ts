import { describe, expect, it } from 'vitest';
import { skyFor } from './skyState';

describe('skyFor', () => {
  it('puts the sun on its arc by the hour, and none at night', () => {
    expect(skyFor(12, 0).sun).toEqual({ x: 0.5, y: 0.12 });
    expect(skyFor(6, 0).sun?.x).toBeCloseTo(0.08);
    expect(skyFor(22, 0).sun).toBeNull();
    expect(skyFor(4, 0).sun).toBeNull();
  });

  it('reads the WMO code the weather line already shows', () => {
    expect(skyFor(12, 0)).toMatchObject({ clouds: 0, precip: null, haze: false });
    expect(skyFor(12, 2)).toMatchObject({ clouds: 3, precip: null });
    expect(skyFor(12, 3)).toMatchObject({ clouds: 7 });
    expect(skyFor(12, 45)).toMatchObject({ haze: true });
    expect(skyFor(12, 61)).toMatchObject({ clouds: 7, precip: 'rain' });
    expect(skyFor(12, 71)).toMatchObject({ precip: 'snow' });
  });

  it('draws a plain sky when there is no reading, rather than claiming weather', () => {
    expect(skyFor(12, null)).toMatchObject({ clouds: 0, precip: null, haze: false });
    expect(skyFor(12, -1)).toMatchObject({ clouds: 0, precip: null, haze: false });
  });
});
