import { describe, expect, it } from 'vitest';
import { placeStories, placeTransform, WORLD, type Placement, type StoryIn } from './layout';

const now = Date.parse('2026-10-09T12:00:00Z');
const DAY = 86_400_000;
const path = (key: string, daysAgo: number): StoryIn => ({ key, lane: 'path', updatedAt: now - daysAgo * DAY });
const feed = (key: string): StoryIn => ({ key, lane: 'feed', updatedAt: now });

function footprint(p: Placement) {
  const w = (p.lane === 'path' ? WORLD.pathWidth : WORLD.feedWidth) / 2;
  return { x0: p.x - w, x1: p.x + w, z0: p.z - WORLD.depth, z1: p.z + WORLD.depth };
}

describe('placeStories', () => {
  it('stands the lead at the origin and the rest further away the longer they were left', () => {
    const { placed } = placeStories([path('a', 0), path('b', 1), path('c', 4), path('d', 30)], now);
    expect(placed[0]).toMatchObject({ key: 'a', x: 0, z: 0, yaw: 0 });
    const distances = placed.map((p) => -p.z);
    for (let i = 1; i < distances.length; i++) expect(distances[i]).toBeGreaterThan(distances[i - 1]);
  });

  it('never lets two panels overlap', () => {
    const stories = [...['a', 'b', 'c', 'd', 'e'].map((k, i) => path(k, i * 0.1)), ...['f', 'g', 'h', 'i'].map(feed)];
    const { placed } = placeStories(stories, now);
    for (const a of placed)
      for (const b of placed) {
        if (a === b) continue;
        const fa = footprint(a);
        const fb = footprint(b);
        const overlap = fa.x0 < fb.x1 && fb.x0 < fa.x1 && fa.z0 < fb.z1 && fb.z0 < fa.z1;
        expect(overlap, `${a.key} overlaps ${b.key}`).toBe(false);
      }
  });

  it('places at most 5 on the path and 9 in all, and counts the rest', () => {
    const stories = [...Array.from({ length: 8 }, (_, i) => path(`p${i}`, i)), ...Array.from({ length: 6 }, (_, i) => feed(`f${i}`))];
    const { placed, overflow } = placeStories(stories, now);
    expect(placed.filter((p) => p.lane === 'path')).toHaveLength(5);
    expect(placed).toHaveLength(9);
    expect(overflow).toBe(14 - 9);
  });

  it('angles the feed lane toward the path and keeps every panel within 20 degrees of yaw', () => {
    const { placed } = placeStories([path('a', 0), feed('f')], now);
    expect(placed[1]).toMatchObject({ lane: 'feed', x: WORLD.feedX });
    for (const p of placed) expect(Math.abs(p.yaw)).toBeLessThanOrEqual(20);
  });

  it('is deterministic and handles nothing at all', () => {
    const stories = [path('a', 0), path('b', 2), feed('f')];
    expect(placeStories(stories, now)).toEqual(placeStories(stories, now));
    expect(placeStories([], now)).toEqual({ placed: [], overflow: 0 });
  });
});

describe('placeTransform', () => {
  it('stands a panel on the ground at its spot, turned by its yaw', () => {
    expect(placeTransform({ x: -220, z: -400, yaw: 0 })).toBe('translate3d(-220px, 0px, -400px) rotateY(0deg)');
  });
});
