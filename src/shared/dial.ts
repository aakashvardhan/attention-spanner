/**
 * The Pomodoro dial's arithmetic, shared by the new tab, the blocked page and
 * the toolbar icon. Progress moves in whole steps, one finished minute at a
 * time, so nothing on the dial changes between them.
 */

/** One segment a minute up to an hour; past that, one per two minutes so each stays legible. */
export function segmentCount(phaseMinutes: number): number {
  const minutes = Math.ceil(phaseMinutes);
  return minutes <= 60 ? minutes : Math.ceil(minutes / 2);
}

/** Segments whose step has fully finished. */
export function litSegments(elapsedMs: number, phaseMs: number, count: number): number {
  if (phaseMs <= 0) return 0;
  return Math.min(count, Math.max(0, Math.floor((elapsedMs / phaseMs) * count)));
}

/**
 * What the dial reads. A focus round shows whole minutes, rounded up, so
 * nothing ticks every second; seconds come back for its last minute. A break
 * always shows m:ss.
 */
export function dialTime(remainingSeconds: number, phase: 'focus' | 'break'): { value: string; unit: 'min' | null } {
  if (phase === 'focus' && remainingSeconds > 60) return { value: String(Math.ceil(remainingSeconds / 60)), unit: 'min' };
  return { value: `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`, unit: null };
}
