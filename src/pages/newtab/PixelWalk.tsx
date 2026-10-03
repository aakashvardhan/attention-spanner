import { useEffect, useRef } from 'react';
import { weatherLabel } from './Weather';

/**
 * A pixel-art street behind the masthead: a skyline for the configured city,
 * the current weather over it, and someone walking along the double rule.
 *
 * One scene pixel is one 4px grid unit, drawn at low resolution and scaled up
 * with `image-rendering: pixelated`. Every colour is read from the theme tokens
 * on each frame, so light, dark and a theme switched in Options all follow
 * without a reload. Reduced motion gets one still frame. There is no lightning:
 * a flash on the new tab is the wrong kind of motion for anyone.
 */
export type Sky = 'clear' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm' | 'calm';

/** Bucketed through weatherLabel so the scene and the readout never disagree. */
export function skyFor(code: number): Sky {
  switch (weatherLabel(code)) {
    case 'Clear':
      return 'clear';
    case 'Partly cloudy':
    case 'Overcast':
      return 'cloudy';
    case 'Fog':
      return 'fog';
    case 'Drizzle':
    case 'Rain':
    case 'Showers':
      return 'rain';
    case 'Snow':
    case 'Snow showers':
      return 'snow';
    case 'Thunderstorm':
      return 'storm';
    default:
      // An unknown code draws no weather rather than a sun it can't vouch for.
      return 'calm';
  }
}

const PX = 4;
const TICK_MS = 125;

// Facing right. '#' ink, 'a' accent (the scarf). Two leg poses alternate.
const TORSO = ['..##.', '..##.', '.aaa.', '.###.', '.###.', '..#..'];
const LEGS = [
  ['.#.#.', '#...#'],
  ['..#..', '..##.'],
];
const UMBRELLA = ['.aaaaa.', 'aaaaaaa', '...#...'];

export function PixelWalk({ code }: { code: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const sky = skyFor(code);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 40;

    const draw = () => {
      const w = Math.max(1, Math.floor(canvas.clientWidth / PX));
      const h = Math.max(1, Math.floor(canvas.clientHeight / PX));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const css = getComputedStyle(canvas);
      const color = (token: string) => css.getPropertyValue(token).trim();
      const rect = (x: number, y: number, rw: number, rh: number, fill: string, alpha = 1) => {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = fill;
        ctx.fillRect(Math.round(x), Math.round(y), rw, rh);
      };
      const hour = new Date().getHours();
      const night = hour < 6 || hour >= 19;
      ctx.clearRect(0, 0, w, h);

      // Sun or moon, only when the sky is actually clear.
      if (sky === 'clear') {
        const cx = Math.floor(w * 0.28);
        if (night) {
          for (let i = 0; i < w / 12; i++) {
            const twinkle = (frame + i * 7) % 24 < 20 ? 0.5 : 0.15;
            rect(rand(i) * w, rand(i + 99) * (h - 14), 1, 1, color('--text-faint'), twinkle);
          }
          disc(cx, 6, 4, color('--border'));
          disc(cx + 2, 5, 3, color('--bg-page')); // the crescent's bite
        } else {
          disc(cx, 6, 4, color('--accent-border'));
        }
      }

      // Clouds drift left to right at a quarter pixel a tick.
      if (sky === 'cloudy' || sky === 'rain' || sky === 'snow' || sky === 'storm') {
        const fill = sky === 'storm' ? color('--text-faint') : color('--border');
        const count = Math.ceil(w / 40);
        for (let i = 0; i < count; i++) {
          const x = ((rand(i) * (w + 24) + frame / 4) % (w + 24)) - 12;
          const y = 1 + Math.floor(rand(i + 7) * 6);
          rect(x + 2, y, 6, 1, fill, 0.8);
          rect(x, y + 1, 11, 2, fill, 0.8);
        }
      }

      // The skyline: deterministic blocks, so the city holds still between frames.
      const ground = h;
      for (let x = 0, i = 0; x < w; i++) {
        const bw = 4 + Math.floor(rand(i + 300) * 6);
        const bh = 3 + Math.floor(rand(i + 600) * 7);
        rect(x, ground - bh, bw, bh, color('--bg-subtle'));
        if (night) {
          for (let wy = ground - bh + 1; wy < ground - 1; wy += 2) {
            for (let wx = x + 1; wx < x + bw - 1; wx += 2) {
              if (rand(wx * 31 + wy) > 0.7) rect(wx, wy, 1, 1, color('--accent-wash'));
            }
          }
        }
        x += bw + (rand(i + 900) > 0.6 ? 1 : 0);
      }

      if (sky === 'fog') {
        for (let band = 0; band < 3; band++) {
          const y = h - 4 - band * 4;
          const x = ((frame / 3 + band * 40) % (w + 60)) - 60;
          rect(x, y, w * 0.6, 2, color('--bg-hover'), 0.7);
        }
      }

      // The walker, on the double rule. Wraps a few pixels off either edge.
      const step = Math.floor(frame / 2) % 2;
      const wx = (frame % (w + 12)) - 6;
      const sprite = [...TORSO, ...LEGS[step]];
      const top = ground - sprite.length - (step === 1 ? 1 : 0);
      paint(sprite, wx, top);
      if (sky === 'rain' || sky === 'storm') paint(UMBRELLA, wx - 1, top - UMBRELLA.length);

      // Precipitation last, so it falls in front of everything.
      if (sky === 'rain' || sky === 'storm') {
        const count = Math.floor(w / (sky === 'storm' ? 2 : 4));
        for (let i = 0; i < count; i++) {
          const x = (rand(i) * w - frame / 2 + w) % w;
          const y = (rand(i + 50) * h + frame * 2) % h;
          rect(x, y, 1, 2, color('--text-faint'), 0.45);
        }
      } else if (sky === 'snow') {
        for (let i = 0; i < w / 4; i++) {
          const x = (rand(i) * w + Math.sin((frame + i * 9) / 6) * 2 + w) % w;
          const y = (rand(i + 50) * h + frame / 2) % h;
          rect(x, y, 1, 1, color('--text-faint'), 0.6);
        }
      }
      ctx.globalAlpha = 1;

      function disc(cx: number, cy: number, r: number, fill: string) {
        for (let y = -r; y <= r; y++) {
          const half = Math.floor(Math.sqrt(r * r - y * y));
          rect(cx - half, cy + y, half * 2 + 1, 1, fill);
        }
      }
      function paint(rows: string[], x: number, y: number) {
        rows.forEach((row, ry) =>
          [...row].forEach((c, rx) => {
            if (c !== '.') rect(x + rx, y + ry, 1, 1, c === 'a' ? color('--accent') : color('--text-muted'));
          }),
        );
      }
    };

    draw();
    // ponytail: redraws the whole canvas every tick — it is ~300×40 pixels, so
    // dirty-rect tracking would cost more code than it saves.
    const timer = setInterval(() => {
      if (document.hidden) return;
      if (!reduced) frame++;
      draw();
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [code]);

  return <canvas ref={ref} className="edition-scene" aria-hidden="true" />;
}

/** Stable pseudo-random in [0, 1) per index, so the scene is the same every frame. */
function rand(i: number): number {
  const s = Math.sin(i * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}
