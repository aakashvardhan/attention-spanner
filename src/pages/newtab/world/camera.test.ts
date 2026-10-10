import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAMERA, LOCKED_TITLE_PX, cameraFor, effectivePx, isBehind, sceneTransform } from './camera';
import type { Placement } from './layout';

const at = (x: number, z: number, yaw = 0, lane: Placement['lane'] = 'path'): Placement => ({ key: 'k', lane, x, z, yaw });

describe('cameraFor', () => {
  it('never pitches or rolls, and turns at most 15 degrees', () => {
    for (const target of [at(0, 0), at(-240, -800), at(720, -600, -20, 'feed'), at(0, 0, 90)]) {
      const c = cameraFor(target);
      expect(c.pitch).toBe(0);
      expect(c.roll).toBe(0);
      expect(Math.abs(c.yaw)).toBeLessThanOrEqual(CAMERA.maxYaw);
    }
  });

  it('stands at the origin with nothing to look at', () => {
    expect(cameraFor(null)).toEqual({ x: 0, z: 0, yaw: 0, pitch: 0, roll: 0 });
  });
});

describe('isBehind', () => {
  it('fades what the camera walked past, so a nearer panel in the same lane never hides the locked one', () => {
    const target = at(720, -600, -20, 'feed');
    expect(isBehind(at(720, -240, -20, 'feed'), target)).toBe(true);
    expect(isBehind(at(720, -960, -20, 'feed'), target)).toBe(false);
    expect(isBehind(at(-240, -400), target)).toBe(false);
    expect(isBehind(at(0, 0), null)).toBe(false);
  });
});

describe('sceneTransform', () => {
  it('moves the world so the target stands viewDepth ahead', () => {
    expect(sceneTransform(cameraFor(at(-240, -800)))).toBe('rotateY(0deg) translate3d(240px, 0px, 560px)');
  });
});

describe('legibility at the lock', () => {
  it('a locked panel title renders at 16px or more', () => {
    expect(effectivePx(LOCKED_TITLE_PX)).toBeGreaterThanOrEqual(16);
  });

  it('the world CSS sets panel titles at --text-xl (24px), the size this test assumes', () => {
    const css = readFileSync(join(__dirname, 'world.css'), 'utf8');
    expect(css).toMatch(/\.world-panel :is\(\.edition-headline, \.relay-row-title, \.edition-story-title\) \{\s*font-size: var\(--text-xl\);/);
  });

  it('the camera glides on --spring-smooth, the spring that never overshoots', () => {
    const css = readFileSync(join(__dirname, 'world.css'), 'utf8');
    expect(css).toMatch(/\.world-scene \{[^}]*transition: transform var\(--dur-smooth\) var\(--spring-smooth\);/);
  });
});
