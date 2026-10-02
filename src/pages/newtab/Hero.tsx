import { useEffect, useState } from 'react';
import { formatTime, localDate } from '../../shared/format';
import { useSettings } from '../../shared/hooks/useSettings';
import { quoteOfDay } from './quotes';
import { Weather } from './Weather';

/**
 * The top band: the time, who you are, and a line to read while the page
 * settles. None of it is a task list — the daily focus field went too, since
 * the one thing you mean to do today already lives in Notion.
 */
export function Hero() {
  const [settings] = useSettings();
  const today = localDate();

  return (
    <header className="relay-hero">
      <Clock />
      <h1 className="relay-greeting">
        {greetingFor(new Date().getHours())}
        {settings.displayName ? `, ${settings.displayName}` : ''}
      </h1>
      <p className="relay-quote">{quoteOfDay(today)}</p>
      <Weather location={settings.weatherLocation} />
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
    <p className="relay-clock">
      <time dateTime={now.toISOString()}>{formatTime(now)}</time>
    </p>
  );
}
