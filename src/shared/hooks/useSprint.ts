import { useEffect, useState } from 'react';
import { sendMessage } from '../messages';
import { useSessionValue } from './useSessionValue';

/**
 * Live sprint state. The countdown is computed client-side from startedAt —
 * no ticking messages from the service worker.
 */
export function useSprint() {
  const [activeSprint] = useSessionValue('activeSprint');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!activeSprint) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [activeSprint]);

  const remainingSeconds = activeSprint
    ? Math.max(
        0,
        Math.round((activeSprint.startedAt + activeSprint.durationMin * 60_000 - now) / 1000),
      )
    : 0;

  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = String(remainingSeconds % 60).padStart(2, '0');

  return {
    active: activeSprint !== null,
    remainingSeconds,
    countdown: `${minutes}:${seconds}`,
    start: () => sendMessage({ type: 'START_SPRINT' }),
    cancel: () => sendMessage({ type: 'CANCEL_SPRINT' }),
  };
}
