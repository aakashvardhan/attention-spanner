import { useEffect, useState } from 'react';
import { formatWatchTime } from '../format';
import { currentlyWatching, livePositionSeconds } from '../youtube';
import { useStorageValue } from './useStorageValue';

/**
 * The YouTube video playing right now, as a live readout.
 *
 * Same shape as useSprint and useFocusSession: subscribe to the stored state,
 * tick locally, and derive the numbers from a timestamp. The tracker's
 * heartbeat lands every five seconds; livePositionSeconds extrapolates between
 * them so the clock advances every tick instead of jumping in five-second
 * steps. Nothing new is stored for any of this.
 */
export function useNowWatching() {
  const [readingProgress] = useStorageValue('readingProgress');
  const [now, setNow] = useState(() => Date.now());

  const video = currentlyWatching(readingProgress, now);
  const active = video !== null;

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active]);

  if (!video) {
    return {
      active: false as const,
      video: null,
      // Exposed so a page showing both this readout and its own live rows ticks
      // off one timer instead of starting a second one at the same interval.
      now,
      position: '',
      duration: '',
      remainingSeconds: 0,
      percent: 0,
      chapter: '',
    };
  }

  const positionSeconds = livePositionSeconds(video, now);
  return {
    active: true as const,
    video,
    now,
    position: formatWatchTime(positionSeconds),
    duration: formatWatchTime(video.durationSeconds),
    remainingSeconds: Math.max(0, Math.round(video.durationSeconds - positionSeconds)),
    percent: video.durationSeconds
      ? Math.min(100, (positionSeconds / video.durationSeconds) * 100)
      : 0,
    chapter: video.chapter ?? '',
  };
}
