import { useEffect, useState } from 'react';
import { sendMessage } from '../messages';
import { useStorageValue } from './useStorageValue';

/**
 * Live focus-session state. Countdown is computed client-side from
 * phaseEndsAt — same pattern as useSprint; all writes go through the SW.
 */
export function useFocusSession() {
  const [session] = useStorageValue('focusSession');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [session]);

  const remainingSeconds = session
    ? Math.max(0, Math.round((session.phaseEndsAt - now) / 1000))
    : 0;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = String(remainingSeconds % 60).padStart(2, '0');

  return {
    session,
    active: session !== null,
    remainingSeconds,
    countdown: `${minutes}:${seconds}`,
    start: (focusMinutes: number) => sendMessage({ type: 'START_FOCUS', focusMinutes }),
    stop: (early: boolean) => sendMessage({ type: 'STOP_FOCUS', early }),
  };
}
