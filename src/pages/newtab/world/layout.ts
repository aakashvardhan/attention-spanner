/**
 * Where everything stands in the new tab's world, as a pure function of what
 * is on the page. Units are CSS pixels; z runs away from you (more negative is
 * further). The path runs straight ahead: the lead stands on it, everything
 * else unfinished stands beside it, further away the longer it was left. The
 * feed lane runs down the right, its panels turned toward the path.
 */

export type Lane = 'path' | 'feed';

export interface StoryIn {
  key: string;
  lane: Lane;
  updatedAt: number;
}

export interface Placement {
  key: string;
  lane: Lane;
  x: number;
  z: number;
  yaw: number;
}

export const WORLD = {
  /** Hick's law: more than nine things to choose from is a list, not a place */
  maxObjects: 9,
  maxPath: 5,
  pathWidth: 360,
  feedWidth: 280,
  /** How thick a standing panel counts as, front to back */
  depth: 40,
  /** Path panels after the lead alternate this far left and right */
  sideX: 240,
  /** Minimum distance between consecutive path panels */
  pathGap: 400,
  /** Extra distance per day since it was last touched */
  dayDepth: 160,
  maxDepth: 3200,
  feedX: 720,
  feedFirstZ: -240,
  feedGap: 360,
  feedYaw: -20,
};

/** A playing video stands just left of the lead, turned toward it. */
export const WATCHING = { x: -640, z: -160, yaw: 20 };
/** The "+N more" sign stands this far past the last thing on the path. */
export const SIGN_OFFSET = 400;

const DAY = 86_400_000;

export function placeStories(stories: readonly StoryIn[], now: number): { placed: Placement[]; overflow: number } {
  const path = stories.filter((s) => s.lane === 'path').slice(0, WORLD.maxPath);
  const feed = stories.filter((s) => s.lane === 'feed').slice(0, WORLD.maxObjects - path.length);
  const placed: Placement[] = [];

  let distance = 0;
  path.forEach((s, i) => {
    if (i > 0) {
      const days = Math.max(0, (now - s.updatedAt) / DAY);
      const byAge = Math.min(WORLD.maxDepth, WORLD.pathGap + days * WORLD.dayDepth);
      distance = Math.max(distance + WORLD.pathGap, byAge);
    }
    const x = i === 0 ? 0 : i % 2 === 1 ? -WORLD.sideX : WORLD.sideX;
    placed.push({ key: s.key, lane: 'path', x, z: -distance || 0, yaw: 0 }); // no -0 for the lead
  });

  feed.forEach((s, i) => {
    placed.push({ key: s.key, lane: 'feed', x: WORLD.feedX, z: WORLD.feedFirstZ - i * WORLD.feedGap, yaw: WORLD.feedYaw });
  });

  return { placed, overflow: stories.length - placed.length };
}

/** The CSS transform that stands a panel's foot at its spot on the ground. */
export function placeTransform(p: { x: number; z: number; yaw: number }): string {
  return `translate3d(${p.x}px, 0px, ${p.z}px) rotateY(${p.yaw}deg)`;
}
