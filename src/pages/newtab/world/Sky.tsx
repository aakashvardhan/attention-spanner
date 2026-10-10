import { useEffect, useRef } from 'react';
import { useAmbient } from '../../../shared/hooks/useAmbient';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { usableReading } from '../Weather';
import { skyFor } from './skyState';

const FRAME_MS = 33;

/**
 * The world's sky: the real hour and the weather line's own reading. Clouds
 * drift and rain falls only while ambient motion runs; otherwise one still
 * frame. Colours are read from the theme tokens every frame, so a theme
 * switched in Settings recolours it without a reload.
 */
export function Sky({ location }: { location: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { running } = useAmbient();
  const [weather] = useStorageValue('weather');
  const code = usableReading(weather, location.trim()) ? weather.code : null;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    let last = 0;
    let t = 0;

    const draw = (now: number) => {
      // React removes the canvas at commit but cancels this frame later, in
      // the passive cleanup; a detached canvas has no tokens to paint with.
      if (!canvas.isConnected) return;
      if (running) raf = requestAnimationFrame(draw);
      if (running && now - last < FRAME_MS) return;
      t += last ? Math.min(now - last, 100) / 1000 : 0;
      last = now;
      const dpr = devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
      if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const css = getComputedStyle(canvas);
      const token = (name: string) => css.getPropertyValue(name).trim();
      const sky = skyFor(new Date().getHours(), code);

      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, token('--sky-top'));
      g.addColorStop(1, token('--sky-horizon'));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      if (sky.sun) {
        ctx.fillStyle = token('--sky-sun');
        ctx.beginPath();
        ctx.arc(sky.sun.x * w, sky.sun.y * h, 24, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = token('--sky-cloud');
      for (let i = 0; i < sky.clouds; i++) {
        const span = w + 240;
        const x = ((i * 197 + t * 8 * (1 + (i % 3) * 0.3)) % span) - 120;
        const y = 24 + ((i * 53) % Math.max(1, h * 0.5));
        const s = 0.7 + (i % 3) * 0.3;
        ctx.beginPath();
        ctx.ellipse(x, y, 60 * s, 14 * s, 0, 0, Math.PI * 2);
        ctx.ellipse(x + 28 * s, y - 8 * s, 40 * s, 12 * s, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      if (sky.haze) {
        ctx.fillStyle = token('--sky-cloud');
        ctx.fillRect(0, h * 0.4, w, h * 0.6);
      }
      if (sky.precip) {
        ctx.strokeStyle = token('--sky-precip');
        ctx.fillStyle = token('--sky-precip');
        for (let i = 0; i < 80; i++) {
          const x = (i * 89) % w;
          const y = ((i * 37 + t * (sky.precip === 'rain' ? 240 : 40)) % h);
          if (sky.precip === 'rain') {
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x - 2, y + 10);
            ctx.stroke();
          } else ctx.fillRect(x, y, 2, 2);
        }
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [running, code]);

  return <canvas ref={ref} className="world-sky" data-running={running || undefined} aria-hidden="true" />;
}
