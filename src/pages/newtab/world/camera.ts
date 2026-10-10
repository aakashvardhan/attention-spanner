import type { Placement } from './layout';

/**
 * The camera, held to the comfort rules VR platforms publish (Meta's
 * locomotion guidance, Apple's visionOS): it never pitches or rolls, turns at
 * most 15 degrees, and stands far enough back that the locked panel's title
 * reads at 16px or more. Where it looks is decided by keyboard focus only.
 */
export const CAMERA = { perspective: 900, viewDepth: 240, stepDepth: 40, maxYaw: 15 };

/** The world's panel title size in px (`--text-xl`; camera.test.ts reads world.css to keep them in step). */
export const LOCKED_TITLE_PX = 24;

/** On-screen size of `px` text standing `depth` behind the perspective plane. */
export function effectivePx(px: number, depth = CAMERA.viewDepth): number {
  return (px * CAMERA.perspective) / (CAMERA.perspective + depth);
}

export interface Camera {
  x: number;
  z: number;
  yaw: number;
  pitch: 0;
  roll: 0;
}

export function cameraFor(target: Placement | null): Camera {
  if (!target) return { x: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
  const yaw = Math.max(-CAMERA.maxYaw, Math.min(CAMERA.maxYaw, target.yaw * 0.7));
  return { x: target.x, z: target.z, yaw, pitch: 0, roll: 0 };
}

/** Move the world, not the eye: the target ends up `depth` ahead, faced. */
export function sceneTransform(c: Camera, depth = CAMERA.viewDepth): string {
  return `rotateY(${-c.yaw}deg) translate3d(${-c.x}px, 0px, ${-c.z - depth}px)`;
}
