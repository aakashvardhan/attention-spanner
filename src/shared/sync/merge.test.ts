import { describe, expect, it } from 'vitest';
import {
  live,
  mergeBadges,
  mergeById,
  mergeCounters,
  mergeDatedMap,
  mergeDayStats,
  mergeGamification,
  mergeNumberMap,
  mergeProgress,
  mergeRecord,
  mergeSrsDayStats,
  mergeStringSet,
  sweepTombstones,
} from './merge';
import type {
  DayStats,
  Gamification,
  LifetimeCounters,
  ReadingProgress,
  SrsDayStats,
  Task,
} from '../types';

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  text: id,
  createdAt: 1000,
  completedAt: null,
  snoozedUntil: null,
  source: 'popup',
  updatedAt: 1000,
  deletedAt: null,
  ...over,
});

describe('mergeRecord', () => {
  it('higher updatedAt wins', () => {
    const a = task('t1', { text: 'old', updatedAt: 100 });
    const b = task('t1', { text: 'new', updatedAt: 200 });
    expect(mergeRecord(a, b).text).toBe('new');
    expect(mergeRecord(b, a).text).toBe('new');
  });

  it('tombstone wins on a timestamp tie', () => {
    const live = task('t1', { updatedAt: 200 });
    const dead = task('t1', { updatedAt: 200, deletedAt: 200 });
    expect(mergeRecord(live, dead).deletedAt).toBe(200);
    expect(mergeRecord(dead, live).deletedAt).toBe(200);
  });

  it('a newer edit still beats an older tombstone', () => {
    const dead = task('t1', { updatedAt: 100, deletedAt: 100 });
    const edit = task('t1', { updatedAt: 200, deletedAt: null });
    expect(mergeRecord(dead, edit).deletedAt).toBeNull();
  });

  it('treats a missing updatedAt as 0 (loses to any real write)', () => {
    const legacy = task('t1', { updatedAt: undefined, text: 'legacy' });
    const synced = task('t1', { updatedAt: 1, text: 'synced' });
    expect(mergeRecord(legacy, synced).text).toBe('synced');
  });
});

describe('mergeById', () => {
  it('unions by id and reconciles overlaps', () => {
    const local = [task('a', { text: 'a-local', updatedAt: 1 }), task('b')];
    const remote = [task('a', { text: 'a-remote', updatedAt: 2 }), task('c')];
    const merged = mergeById(local, remote);
    expect(merged.map((t) => t.id).sort()).toEqual(['a', 'b', 'c']);
    expect(merged.find((t) => t.id === 'a')!.text).toBe('a-remote');
  });

  it('retains tombstones so deletes propagate', () => {
    const local = [task('a')];
    const remote = [task('a', { updatedAt: 2000, deletedAt: 2000 })];
    const merged = mergeById(local, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].deletedAt).toBe(2000);
    expect(live(merged)).toHaveLength(0);
  });
});

describe('sweepTombstones', () => {
  it('purges old tombstones but keeps live records and recent deletes', () => {
    const now = 10_000;
    const records = [
      task('keep'),
      task('recent', { deletedAt: 9_000 }),
      task('old', { deletedAt: 1_000 }),
    ];
    const kept = sweepTombstones(records, now, 5_000).map((r) => r.id);
    expect(kept).toEqual(['keep', 'recent']);
  });
});

describe('mergeStringSet', () => {
  it('unions preserving local order then appends new remote entries', () => {
    expect(mergeStringSet(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });
});

describe('mergeDayStats', () => {
  it('takes the field-wise max and never sums', () => {
    const a: DayStats = { minutes: 10, sprints: 2, articlesFinished: 1 };
    const b: DayStats = { minutes: 5, sprints: 3, articlesFinished: 0, videosFinished: 2 };
    expect(mergeDayStats(a, b)).toEqual({
      minutes: 10,
      sprints: 3,
      articlesFinished: 1,
      videosFinished: 2,
      focusBlocks: 0,
      tasksCompleted: 0,
    });
  });
});

describe('mergeNumberMap / mergeSrsDayStats', () => {
  it('takes per-key max', () => {
    expect(mergeNumberMap({ d1: 3, d2: 1 }, { d1: 2, d3: 5 })).toEqual({ d1: 3, d2: 1, d3: 5 });
  });

  it('merges both SRS sub-maps', () => {
    const a: SrsDayStats = { reviews: { d1: 5 }, newIntroduced: { d1: 2 } };
    const b: SrsDayStats = { reviews: { d1: 3, d2: 1 }, newIntroduced: { d1: 4 } };
    expect(mergeSrsDayStats(a, b)).toEqual({
      reviews: { d1: 5, d2: 1 },
      newIntroduced: { d1: 4 },
    });
  });
});

describe('mergeDatedMap', () => {
  it('merges overlapping days and carries through single-sided days', () => {
    const a: Record<string, DayStats> = {
      '2026-07-08': { minutes: 5, sprints: 1, articlesFinished: 0 },
      '2026-07-09': { minutes: 10, sprints: 0, articlesFinished: 1 },
    };
    const b: Record<string, DayStats> = {
      '2026-07-09': { minutes: 3, sprints: 2, articlesFinished: 2 },
      '2026-07-10': { minutes: 8, sprints: 1, articlesFinished: 0 },
    };
    const merged = mergeDatedMap(a, b, mergeDayStats);
    expect(Object.keys(merged).sort()).toEqual(['2026-07-08', '2026-07-09', '2026-07-10']);
    expect(merged['2026-07-09']).toMatchObject({ minutes: 10, sprints: 2, articlesFinished: 2 });
  });
});

const counters = (over: Partial<LifetimeCounters> = {}): LifetimeCounters => ({
  workouts: 0,
  articlesFinished: 0,
  videosFinished: 0,
  sprints: 0,
  tasksCompleted: 0,
  brainDumps: 0,
  focusBlocks: 0,
  cardsReviewed: 0,
  chestsOpened: 0,
  ...over,
});

describe('mergeCounters', () => {
  it('takes per-field max of monotonic counters', () => {
    const a = counters({ workouts: 3, sprints: 10 });
    const b = counters({ workouts: 5, tasksCompleted: 2 });
    expect(mergeCounters(a, b)).toMatchObject({ workouts: 5, sprints: 10, tasksCompleted: 2 });
  });
});

describe('mergeBadges', () => {
  it('unions badges keeping the earliest unlock', () => {
    expect(mergeBadges({ first: 500, only_a: 1 }, { first: 300, only_b: 2 })).toEqual({
      first: 300,
      only_a: 1,
      only_b: 2,
    });
  });
});

describe('mergeGamification', () => {
  it('maxes xp/counters, unions badges, keeps latest quest week', () => {
    const a: Gamification = {
      xp: 100,
      badges: { x: 10 },
      lastQuestCelebratedWeek: '2026-07-06',
      counters: counters({ sprints: 4 }),
    };
    const b: Gamification = {
      xp: 80,
      badges: { y: 20 },
      lastQuestCelebratedWeek: '2026-06-29',
      counters: counters({ sprints: 6 }),
    };
    const merged = mergeGamification(a, b);
    expect(merged.xp).toBe(100);
    expect(merged.counters.sprints).toBe(6);
    expect(merged.badges).toEqual({ x: 10, y: 20 });
    expect(merged.lastQuestCelebratedWeek).toBe('2026-07-06');
  });
});

const progress = (over: Partial<ReadingProgress> = {}): ReadingProgress => ({
  kind: 'article',
  url: 'https://example.com/a',
  title: 'A',
  source: 'Feed',
  maxPercent: 0,
  activeSeconds: 0,
  firstOpenedAt: 1000,
  updatedAt: 1000,
  completedAt: null,
  nudge: { count: 0, lastAt: 0, dismissed: false },
  feedItemId: null,
  scrollY: 0,
  pageHeight: 0,
  ...over,
});

describe('mergeProgress', () => {
  it('maxes progress metrics and keeps the earliest open/completion', () => {
    const a = progress({ maxPercent: 40, activeSeconds: 30, firstOpenedAt: 500, updatedAt: 500 });
    const b = progress({
      maxPercent: 70,
      activeSeconds: 20,
      firstOpenedAt: 900,
      updatedAt: 900,
      completedAt: 950,
    });
    const merged = mergeProgress(a, b);
    expect(merged.maxPercent).toBe(70);
    expect(merged.activeSeconds).toBe(30);
    expect(merged.firstOpenedAt).toBe(500);
    expect(merged.updatedAt).toBe(900);
    expect(merged.completedAt).toBe(950);
  });

  it('takes position-specific fields from the more recently updated record', () => {
    const older = progress({ updatedAt: 100, scrollY: 10 });
    const newer = progress({ updatedAt: 200, scrollY: 999 });
    expect(mergeProgress(older, newer).scrollY).toBe(999);
    expect(mergeProgress(newer, older).scrollY).toBe(999);
  });

  it('ORs the nudge dismissed flag and maxes the count', () => {
    const a = progress({ nudge: { count: 1, lastAt: 5, dismissed: false } });
    const b = progress({ nudge: { count: 2, lastAt: 3, dismissed: true } });
    const merged = mergeProgress(a, b);
    expect(merged.nudge).toEqual({ count: 2, lastAt: 5, dismissed: true });
  });
});
