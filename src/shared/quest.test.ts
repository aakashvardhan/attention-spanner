import { describe, expect, it } from 'vitest';
import { questProgress } from './quest';
import type { DayStats } from './types';

const WEEK = '2026-06-22'; // Mon
const day = (partial: Partial<DayStats>): DayStats => ({
  minutes: 0,
  sprints: 0,
  articlesFinished: 0,
  ...partial,
});

const SETTINGS = {
  gymWeeklyTarget: 3,
  questArticlesPerWeek: 2,
  questSprintsPerWeek: 5,
  questVideosPerWeek: 0,
  questFocusPerWeek: 0,
};

describe('questProgress', () => {
  it('sums progress across the week only', () => {
    const checkins = { '2026-06-22': 1, '2026-06-24': 1, '2026-06-29': 1 /* next week */ };
    const daily = {
      '2026-06-23': day({ articlesFinished: 1, sprints: 2 }),
      '2026-06-28': day({ articlesFinished: 1, sprints: 3 }), // Sunday, in week
      '2026-06-21': day({ articlesFinished: 5, sprints: 5 }), // previous Sunday, out
    };
    const q = questProgress(checkins, daily, SETTINGS, WEEK);
    expect(q.lines.find((l) => l.key === 'gym')?.current).toBe(2);
    expect(q.lines.find((l) => l.key === 'articles')?.current).toBe(2);
    expect(q.lines.find((l) => l.key === 'sprints')?.current).toBe(5);
    expect(q.complete).toBe(false); // gym 2/3
  });

  it('completes when every included line meets its target', () => {
    const checkins = { '2026-06-22': 1, '2026-06-24': 1, '2026-06-26': 1 };
    const daily = { '2026-06-23': day({ articlesFinished: 2, sprints: 5 }) };
    expect(questProgress(checkins, daily, SETTINGS, WEEK).complete).toBe(true);
  });

  it('excludes zero-target lines', () => {
    const q = questProgress({}, {}, { ...SETTINGS, questArticlesPerWeek: 0 }, WEEK);
    expect(q.lines.map((l) => l.key)).toEqual(['gym', 'sprints']);
  });

  it('is never complete when all targets are zero', () => {
    const q = questProgress(
      {},
      {},
      {
        gymWeeklyTarget: 0,
        questArticlesPerWeek: 0,
        questSprintsPerWeek: 0,
        questVideosPerWeek: 0,
        questFocusPerWeek: 0,
      },
      WEEK,
    );
    expect(q.lines).toHaveLength(0);
    expect(q.complete).toBe(false);
  });

  it('sums the videos line and tolerates legacy days without videosFinished', () => {
    const daily = {
      '2026-06-23': day({ videosFinished: 1 }),
      '2026-06-25': { minutes: 10, sprints: 0, articlesFinished: 0 }, // legacy shape
    };
    const q = questProgress({}, daily, { ...SETTINGS, questVideosPerWeek: 2 }, WEEK);
    const videos = q.lines.find((l) => l.key === 'videos');
    expect(videos?.current).toBe(1);
    expect(videos?.target).toBe(2);
  });
});
