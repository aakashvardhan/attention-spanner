import { useEffect, useRef, useState } from 'react';
import { HOLD_TO_QUIT_MS } from '../constants';
import './holdToQuit.css';

/**
 * Press-and-hold friction button: enough pause to break the impulse,
 * never enough to trap you. Releasing before the hold completes resets.
 */
export function HoldToQuit({
  onConfirm,
  label = 'Hold to end early',
  holdMs = HOLD_TO_QUIT_MS,
}: {
  onConfirm: () => void;
  label?: string;
  holdMs?: number;
}) {
  const [progress, setProgress] = useState(0);
  const timerRef = useRef<number | null>(null);
  const firedRef = useRef(false);

  const clear = () => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setProgress(0);
  };

  useEffect(() => clear, []);

  const onDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    firedRef.current = false;
    const startedAt = performance.now();
    timerRef.current = window.setInterval(() => {
      const fraction = Math.min(1, (performance.now() - startedAt) / holdMs);
      setProgress(fraction);
      if (fraction >= 1 && !firedRef.current) {
        firedRef.current = true;
        clear();
        onConfirm();
      }
    }, 50);
  };

  const holding = progress > 0;
  const secondsLeft = Math.ceil(((1 - progress) * holdMs) / 1000);

  return (
    <button
      className="hold-to-quit"
      onPointerDown={onDown}
      onPointerUp={clear}
      onPointerCancel={clear}
      onLostPointerCapture={clear}
    >
      <span className="hold-fill" style={{ width: `${progress * 100}%` }} />
      <span className="hold-label">{holding ? `Keep holding… ${secondsLeft}s` : label}</span>
    </button>
  );
}
