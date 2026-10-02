import { useEffect, useRef, useState } from 'react';
import { driftStep, type DriftEvent, type DriftState } from '../../shared/readingAids';

const TICK_MS = 15_000;
const SHOW_MS = 10_000;

/**
 * "You were at 3.2 Attention · Back" after attention wanders: three quiet
 * minutes in view, or a return after two minutes on another tab. The anchor
 * is the position when the drift began, so Back undoes any aimless scrolling.
 */
export function useDriftNudge<P>(
  position: P,
  label: (p: P) => string,
  restore: (p: P) => void,
): { message: string; back: () => void } | null {
  const state = useRef<DriftState>({ lastActivity: Date.now(), hiddenAt: null, nudged: false });
  const anchor = useRef(position);
  const latest = useRef(position);
  latest.current = position;
  // Listeners bind once, so they read the newest label/restore through a ref —
  // the PDF outline arrives after the first render and a captured label would
  // say "page N" forever.
  const fns = useRef({ label, restore });
  fns.current = { label, restore };
  const [nudge, setNudge] = useState<{ message: string; back: () => void } | null>(null);

  useEffect(() => {
    let hideTimer = 0;
    const feed = (type: DriftEvent['type']) => {
      if (type === 'activity' && !state.current.nudged) anchor.current = latest.current;
      if (type === 'hidden') anchor.current = latest.current;
      const out = driftStep(state.current, { type, at: Date.now() });
      state.current = out.state;
      if (!out.nudge) return;
      const target = anchor.current;
      setNudge({
        message: `You were at ${fns.current.label(target)}`,
        back: () => (fns.current.restore(target), setNudge(null)),
      });
      clearTimeout(hideTimer);
      hideTimer = self.setTimeout(() => setNudge(null), SHOW_MS);
    };
    const onActivity = () => feed('activity');
    const onVisibility = () => feed(document.hidden ? 'hidden' : 'visible');
    const tick = self.setInterval(() => !document.hidden && feed('tick'), TICK_MS);
    for (const e of ['scroll', 'keydown', 'pointermove', 'wheel'] as const) {
      window.addEventListener(e, onActivity, { passive: true, capture: true });
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(tick);
      clearTimeout(hideTimer);
      for (const e of ['scroll', 'keydown', 'pointermove', 'wheel'] as const) {
        window.removeEventListener(e, onActivity, { capture: true });
      }
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return nudge;
}
