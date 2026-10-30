import { useEffect, useState } from 'react';
import { currentlyWatching } from '../youtube';
import { useStorageValue } from './useStorageValue';

/** Tick interval while a video plays, or null to stand still. */
export function watchTickMs(watching: boolean): number | null {
  return watching ? 500 : null;
}

/**
 * The page's one clock: the current ms, ticking every 500 ms while a YouTube
 * video is playing and standing still when nothing is.
 *
 * The tracker's heartbeat lands every five seconds; livePositionSeconds
 * extrapolates between them off this value, so a Continue row's watch time
 * advances every tick instead of jumping in five-second steps. Nothing new is
 * stored for any of this.
 */
export function useWatchClock(): number {
  const [readingProgress] = useStorageValue('readingProgress');
  const [now, setNow] = useState(() => Date.now());
  const tick = watchTickMs(currentlyWatching(readingProgress, now) !== null);

  useEffect(() => {
    if (tick === null) return;
    const timer = setInterval(() => setNow(Date.now()), tick);
    return () => clearInterval(timer);
  }, [tick]);

  return now;
}
