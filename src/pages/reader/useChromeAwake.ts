import { useEffect, useState } from 'react';

const IDLE_MS = 2500;
const WAKE_ZONE_PX = 48;

/**
 * Whether the reader's toolbar should show. It sleeps after a moment of
 * reading and wakes at the top edge or on scroll-up — the page is the
 * interface. `pinned` (a panel open) keeps it awake; reduced motion keeps it
 * awake for good. Focus inside the toolbar keeps it visible through CSS
 * (:focus-within), so keyboard users never lose it.
 */
export function useChromeAwake(pinned: boolean): boolean {
  const [awake, setAwake] = useState(true);
  useEffect(() => {
    if (pinned || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setAwake(true);
      return;
    }
    let timer = self.setTimeout(() => setAwake(false), IDLE_MS);
    const wake = () => {
      setAwake(true);
      clearTimeout(timer);
      timer = self.setTimeout(() => setAwake(false), IDLE_MS);
    };
    const onMove = (e: PointerEvent) => {
      if (e.clientY <= WAKE_ZONE_PX) wake();
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) wake();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('wheel', onWheel);
    };
  }, [pinned]);
  return awake;
}
