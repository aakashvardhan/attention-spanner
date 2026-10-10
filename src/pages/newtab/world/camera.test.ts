import { describe, expect, it } from 'vitest';
import { CAMERA, LOCKED_TITLE_PX, cameraFor, effectivePx, sceneTransform } from './camera';
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

describe('sceneTransform', () => {
  it('moves the world so the target stands viewDepth ahead', () => {
    expect(sceneTransform(cameraFor(at(-240, -800)))).toBe('rotateY(0deg) translate3d(240px, 0px, 560px)');
  });
});

describe('legibility at the lock', () => {
  it('a locked panel title renders at 16px or more', () => {
    expect(effectivePx(LOCKED_TITLE_PX)).toBeGreaterThanOrEqual(16);
  });
});
