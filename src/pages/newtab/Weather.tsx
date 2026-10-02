import { useEffect } from 'react';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { setLocal } from '../../shared/storage';
import type { WeatherCache } from '../../shared/types';

/**
 * Current conditions for the city set in Settings.
 *
 * Open-Meteo, because it needs no API key and no account — so there is no
 * secret to store and nothing to sign up for. <all_urls> is already granted, so
 * this adds no permission, and the MV3 policy here restricts script-src and
 * object-src only, which does not touch fetch.
 *
 * No city set means no widget. This never asks for the geolocation permission:
 * a typed city is one Settings field against a permission prompt on the new tab.
 */
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** Weather moves slower than a new tab does. */
const MAX_AGE_MS = 30 * 60 * 1000;

export function Weather({ location }: { location: string }) {
  const [cached] = useStorageValue('weather');
  const query = location.trim();
  const fresh = cached && cached.query === query && !isStale(cached.fetchedAt, Date.now());

  useEffect(() => {
    if (!query || fresh) return;
    let alive = true;
    void fetchWeather(query, cached).then((next) => {
      if (alive && next) void setLocal({ weather: next });
    });
    return () => {
      alive = false;
    };
  }, [query, fresh, cached]);

  if (!usableReading(cached, query)) return null;

  return (
    <p className="relay-weather">
      <span className="relay-weather-temp">{formatTemp(cached.tempC)}</span>
      {' · '}
      {weatherLabel(cached.code)}
      {' · '}
      <span className="relay-weather-place">{cached.name}</span>
    </p>
  );
}

/**
 * Distance rather than difference, so a reading stamped in the future counts as
 * stale too. A clock that jumped forward, cached a temperature and jumped back
 * would otherwise hold that reading until real time caught up with the bad
 * timestamp — which could be hours, or never.
 */
/**
 * Whether a cached reading may go on screen for the city currently configured.
 *
 * Staleness deliberately does not disqualify it: an old temperature still beats
 * an empty slot while the refetch is in flight, and it is what survives a failed
 * one. What does disqualify it is being about somewhere else, or not carrying a
 * number — `null * 9 / 5 + 32` is 32, so an unguarded render reports a missing
 * value as a confident 32°F.
 *
 * A type predicate, so passing it makes `cached` non-null for the render below.
 */
export function usableReading(
  cached: WeatherCache | null,
  query: string,
): cached is WeatherCache {
  return Boolean(query) && cached?.query === query && Number.isFinite(cached.tempC);
}

export function isStale(fetchedAt: number, now: number): boolean {
  return Math.abs(now - fetchedAt) >= MAX_AGE_MS;
}

/**
 * WMO weather codes, bucketed. The full table splits by intensity — light,
 * moderate and dense drizzle are three codes — which is more than a one-line
 * readout can use, so each family collapses to the word you'd actually say.
 */
export function weatherLabel(code: number): string {
  // The ladder below ends in an unguarded `return 'Thunderstorm'`, so anything
  // that fails every comparison — a missing field, a null, a NaN, a code past
  // the end of the WMO table — would claim a storm. Say nothing instead of
  // saying something wrong about the weather.
  if (!Number.isFinite(code) || code < 0 || code > 99) return 'Unknown';
  if (code === 0) return 'Clear';
  if (code <= 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code <= 48) return 'Fog';
  if (code <= 57) return 'Drizzle';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Showers';
  if (code <= 86) return 'Snow showers';
  return 'Thunderstorm';
}

/**
 * ponytail: the unit follows the browser's locale rather than a setting — the
 * three countries on Fahrenheit are the three this check catches. Promote it to
 * a Settings toggle if the guess is ever wrong for you.
 */
function formatTemp(tempC: number): string {
  const region = navigator.language.split('-')[1]?.toUpperCase();
  return region === 'US' || region === 'LR' || region === 'MM'
    ? `${Math.round((tempC * 9) / 5 + 32)}°F`
    : `${Math.round(tempC)}°C`;
}

/**
 * Geocodes only when the city changed — coordinates for a place you already
 * resolved do not need looking up again, so a refresh is one request, not two.
 * Returns null on any failure; the caller keeps whatever it had.
 */
async function fetchWeather(query: string, cached: WeatherCache | null): Promise<WeatherCache | null> {
  try {
    let place =
      cached && cached.query === query
        ? { name: cached.name, lat: cached.lat, lon: cached.lon }
        : null;

    if (!place) {
      const url = `${GEOCODE_URL}?name=${encodeURIComponent(query)}&count=1`;
      const results = (await fetchJson(url))?.results as
        | { name: string; latitude: number; longitude: number }[]
        | undefined;
      const hit = results?.[0];
      if (!hit) return null;
      place = { name: hit.name, lat: hit.latitude, lon: hit.longitude };
    }

    const forecast = await fetchJson(
      `${FORECAST_URL}?latitude=${place.lat}&longitude=${place.lon}&current=temperature_2m,weather_code`,
    );
    const current = forecast?.current as
      | { temperature_2m: number; weather_code: number }
      | undefined;
    // Both fields are checked, not just the temperature: an unvalidated code
    // reaches weatherLabel, and a label is a claim about the weather.
    if (!current || !Number.isFinite(current.temperature_2m)) return null;

    return {
      query,
      name: place.name,
      lat: place.lat,
      lon: place.lon,
      tempC: current.temperature_2m,
      // Kept as -1 when absent rather than dropping the whole reading — the
      // temperature is the part worth showing, and weatherLabel renders an
      // unusable code as 'Unknown'.
      code: Number.isFinite(current.weather_code) ? current.weather_code : -1,
      fetchedAt: Date.now(),
    };
  } catch {
    // A new tab is the wrong place to report that a weather server is down.
    return null;
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(url);
  return response.ok ? ((await response.json()) as Record<string, unknown>) : null;
}
