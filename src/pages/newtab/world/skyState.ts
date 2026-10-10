export interface SkyState {
  /** Fractions of the canvas; null between 18:00 and 06:00 */
  sun: { x: number; y: number } | null;
  clouds: number;
  precip: 'rain' | 'snow' | null;
  haze: boolean;
}

/**
 * The sky the clock and the weather line say it is. A missing or unknown
 * reading draws a plain sky: weather on screen is a claim, the same rule
 * Weather.tsx follows for its label.
 */
export function skyFor(hour: number, code: number | null): SkyState {
  const day = hour >= 6 && hour < 18;
  const t = (hour - 6) / 12; // 0 at 06:00, 0.5 at noon, 1 at 18:00
  const sun = day ? { x: Number((0.08 + 0.84 * t).toFixed(2)), y: Number((0.12 + 0.5 * (2 * t - 1) ** 2).toFixed(2)) } : null;
  if (code === null || !Number.isFinite(code) || code < 0 || code > 99) return { sun, clouds: 0, precip: null, haze: false };
  if (code === 0) return { sun, clouds: 0, precip: null, haze: false };
  if (code <= 2) return { sun, clouds: 3, precip: null, haze: false };
  if (code === 3) return { sun, clouds: 7, precip: null, haze: false };
  if (code <= 48) return { sun, clouds: 2, precip: null, haze: true };
  if (code <= 67 || (code >= 80 && code <= 82) || code >= 95) return { sun, clouds: 7, precip: 'rain', haze: false };
  return { sun, clouds: 7, precip: 'snow', haze: false };
}
