import { useRef } from 'react';
import type { useFocusSession } from '../hooks/useFocusSession';
import './focusDial.css';

type Focus = ReturnType<typeof useFocusSession>;

/** Circumference of the r=52 ring in viewBox units */
const CIRC = 2 * Math.PI * 52;

/**
 * The Pomodoro dial: one segment per minute. Finished segments are lit, the
 * minute in progress is a faint mark, and nothing moves between steps; a new
 * segment fades in as its minute lands. When a phase ends the full ring settles
 * once and lets go.
 */
export function FocusDial({ focus }: { focus: Focus }) {
  const session = focus.session;
  // The phase this dial first rendered: only a change after that settles.
  const firstPhase = useRef(session?.phaseStartedAt);
  if (!session) return null;
  firstPhase.current ??= session.phaseStartedAt;
  const settled = session.phaseStartedAt !== firstPhase.current;

  const n = focus.segments;
  const k = focus.lit;
  const gap = Math.min(0.4, (3 * n) / CIRC);
  const seg = 1 - gap;
  const run = (count: number) => Array.from({ length: count }, () => `${seg} ${gap}`).join(' ');
  const label = focus.phase === 'break' ? 'Break' : 'Focus';

  return (
    <div className="pomo-dial-wrap" role="timer" aria-label={`${label}, ${focus.display.value}${focus.display.unit ? ' minutes' : ''} left`}>
      <svg className="pomo-dial" viewBox="0 0 120 120" aria-hidden="true">
        <circle className="pomo-track" cx="60" cy="60" r="52" pathLength={n} strokeDasharray={`${seg} ${gap}`} />
        {k > 1 && <circle className="pomo-lit" cx="60" cy="60" r="52" pathLength={n} strokeDasharray={`${run(k - 1)} 0 ${n}`} />}
        {k > 0 && (
          <circle key={k} className="pomo-lit pomo-lit--new" cx="60" cy="60" r="52" pathLength={n} strokeDasharray={`0 ${k - 1} ${seg} ${n}`} />
        )}
        {k < n && <circle className="pomo-now" cx="60" cy="60" r="52" pathLength={n} strokeDasharray={`0 ${k} ${seg} ${n}`} />}
        {settled && <circle key={session.phaseStartedAt} className="pomo-settle" cx="60" cy="60" r="52" />}
      </svg>
      <span key={label} className="pomo-dial-text">
        <span className="pomo-time">{focus.display.value}</span>
        <span className="pomo-phase">{focus.display.unit ?? label}</span>
      </span>
    </div>
  );
}
