import { useEffect, useState } from 'react';
import { dialTime, litSegments, segmentCount } from '../dial';
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
  // reconcileFocusOnStartup fills these in on a session from before Pomodoro.
  const phase = session?.phase ?? null;
  const phaseStartedAt = session?.phaseStartedAt ?? 0;
  const phaseMs = session ? session.phaseEndsAt - phaseStartedAt : 0;
  const segments = segmentCount(phaseMs / 60_000);
  const lit = litSegments(now - phaseStartedAt, phaseMs, segments);

  return {
    session,
    /** Clocked in, in either phase */
    active: session !== null,
    phase,
    /** Clocked in and in a focus round: the blocking phase */
    focusing: phase === 'focus',
    round: session?.round ?? 0,
    remainingSeconds,
    countdown: `${minutes}:${seconds}`,
    /** What the dial reads: whole minutes in focus, m:ss in its last minute and in a break */
    display: dialTime(remainingSeconds, phase ?? 'focus'),
    /** The dial's steps: one per minute (two past an hour), and how many have finished */
    segments,
    lit,
    now,
    clockedMs: session ? now - session.startedAt : 0,
    start: (focusMinutes: number, intention?: string) => sendMessage({ type: 'START_FOCUS', focusMinutes, intention }),
    stop: (early: boolean) => sendMessage({ type: 'STOP_FOCUS', early }),
    skipBreak: () => sendMessage({ type: 'SKIP_BREAK' }),
  };
}
