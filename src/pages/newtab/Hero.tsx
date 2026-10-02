import { useEffect, useState } from 'react';
import { formatTime } from '../../shared/format';
import { useSettings } from '../../shared/hooks/useSettings';
import { Weather } from './Weather';

/**
 * The masthead. The edition's name is the greeting (Morning, Afternoon,
 * Evening, Late), with the date on one side and the time and weather on the
 * other; the dek under the double rule says who it is for and what is waiting.
 */
export function Hero({ status }: { status: string }) {
  const [settings] = useSettings();
  const now = new Date();
  const hour = now.getHours();
  const greeting = `${greetingFor(hour)}${settings.displayName ? `, ${settings.displayName}` : ''}`;

  return (
    <header className="edition-masthead">
      <p className="edition-dateline">
        {now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
      </p>
      <h1 className="edition-name">{editionName(hour)}</h1>
      <div className="edition-weatherline">
        <Clock />
        <Weather location={settings.weatherLocation} />
      </div>
      <p className="edition-dek">
        <span>{greeting.endsWith('?') ? greeting : `${greeting}.`}</span>
        <span>{status}</span>
      </p>
    </header>
  );
}

/** Wall-clock greeting. 'Up late?' before 5am is the honest one for this app. */
export function greetingFor(hour: number): string {
  if (hour < 5) return 'Up late?';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** The masthead. Same boundaries as greetingFor, so the two never disagree. */
export function editionName(hour: number): string {
  if (hour < 5) return 'The Late Edition';
  if (hour < 12) return 'The Morning Edition';
  if (hour < 18) return 'The Afternoon Edition';
  return 'The Evening Edition';
}

function Clock() {
  const [now, setNow] = useState(() => new Date());

  // Aligned to the next minute rather than ticking every second: the display is
  // h:mm, so a per-second interval would re-render sixty times to change nothing.
  useEffect(() => {
    let timer: number;
    const schedule = () => {
      const next = 60_000 - (Date.now() % 60_000);
      timer = self.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, next);
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  return (
    <time className="edition-clock" dateTime={now.toISOString()}>
      {formatTime(now)}
    </time>
  );
}
