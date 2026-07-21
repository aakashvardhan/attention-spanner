import { describe, expect, it } from 'vitest';
import { BADGES, type StatsSnapshot } from './badges';

const ZERO: StatsSnapshot = {
  workouts: 0,
  gymWeekStreak: 0,
  articlesFinished: 0,
  videosFinished: 0,
  readingStreak: 0,
  sprints: 0,
  tasksCompleted: 0,
  brainDumps: 0,
  focusBlocks: 0,
  cardsReviewed: 0,
  chestsOpened: 0,
  warmups: 0,
  level: 1,
};

// [badgeId, snapshot field, threshold]
const THRESHOLDS: [string, keyof StatsSnapshot, number][] = [
  ['first-workout', 'workouts', 1],
  ['gym-10', 'workouts', 10],
  ['gym-50', 'workouts', 50],
  ['gym-streak-4', 'gymWeekStreak', 4],
  ['gym-streak-12', 'gymWeekStreak', 12],
  ['first-article', 'articlesFinished', 1],
  ['articles-10', 'articlesFinished', 10],
  ['articles-50', 'articlesFinished', 50],
  ['first-video', 'videosFinished', 1],
  ['videos-10', 'videosFinished', 10],
  ['videos-50', 'videosFinished', 50],
  ['read-streak-7', 'readingStreak', 7],
  ['read-streak-30', 'readingStreak', 30],
  ['sprints-25', 'sprints', 25],
  ['sprints-100', 'sprints', 100],
  ['first-focus', 'focusBlocks', 1],
  ['focus-25', 'focusBlocks', 25],
  ['focus-100', 'focusBlocks', 100],
  ['tasks-50', 'tasksCompleted', 50],
  ['cards-100', 'cardsReviewed', 100],
  ['dumps-10', 'brainDumps', 10],
  ['chests-10', 'chestsOpened', 10],
  ['level-5', 'level', 5],
  ['level-10', 'level', 10],
];

describe('BADGES', () => {
  it('has unique ids and covers the full catalog', () => {
    const ids = BADGES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(THRESHOLDS.map(([id]) => id).sort());
  });

  it.each(THRESHOLDS)('%s flips exactly at its threshold', (id, field, threshold) => {
    const badge = BADGES.find((b) => b.id === id)!;
    expect(badge.earned({ ...ZERO, [field]: threshold - 1 })).toBe(false);
    expect(badge.earned({ ...ZERO, [field]: threshold })).toBe(true);
  });

  it('none are earned on a fresh profile', () => {
    expect(BADGES.filter((b) => b.earned(ZERO))).toHaveLength(0);
  });
});
