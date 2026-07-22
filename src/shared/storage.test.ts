import { describe, expect, it } from 'vitest';
import { v7Patch } from './storage';

/**
 * v6 → v7 collapses the reward layer onto one currency. These cover the
 * shapes a real v6 profile can hold, including the ones that must NOT be
 * touched (a profile already free of the dead keys).
 */
describe('v7Patch', () => {
  it('drops xp and quest bookkeeping, keeping badges and counters', () => {
    const patch = v7Patch({
      gamification: {
        xp: 1240,
        lastQuestCelebratedWeek: '2026-07-06',
        badges: { 'first-workout': 111 },
        counters: { workouts: 3, chestsOpened: 7 },
      },
    });
    expect(patch.gamification).toEqual({
      badges: { 'first-workout': 111 },
      counters: { workouts: 3, freezesEarned: 7 },
    });
  });

  it('leaves freezesEarned alone when there was no chest counter', () => {
    const patch = v7Patch({
      gamification: { xp: 0, badges: {}, counters: { workouts: 1 } },
    });
    expect(patch.gamification).toEqual({ badges: {}, counters: { workouts: 1 } });
  });

  it('removes the quest settings and the progress card slot', () => {
    const patch = v7Patch({
      settings: {
        questArticlesPerWeek: 2,
        questSprintsPerWeek: 5,
        questVideosPerWeek: 1,
        questFocusPerWeek: 5,
        dailyGoalMinutes: 10,
        dashCardOrder: ['feeds', 'progress', 'tasks'],
        dashHiddenCards: ['progress'],
        dashFullWidthCards: [],
      },
    });
    expect(patch.settings).toEqual({
      dailyGoalMinutes: 10,
      dashCardOrder: ['feeds', 'tasks'],
      dashHiddenCards: [],
      dashFullWidthCards: [],
    });
  });

  it('rewrites chest markers to the bare rolled flag', () => {
    const patch = v7Patch({
      tasks: [
        { id: 'a', chest: { bonusXp: 25 } },
        { id: 'b', chest: { bonusXp: 0 } },
        { id: 'c' },
      ],
    });
    expect(patch.tasks).toEqual([
      { id: 'a', chest: { rolled: true } },
      { id: 'b', chest: { rolled: true } },
      { id: 'c' },
    ]);
  });

  it('skips the task rewrite when every chest is already migrated', () => {
    const patch = v7Patch({ tasks: [{ id: 'a', chest: { rolled: true } }, { id: 'b' }] });
    expect(patch.tasks).toBeUndefined();
  });

  it('wraps pdf annotations into the anchor union', () => {
    const patch = v7Patch({
      pdfAnnotations: [
        {
          id: 'a',
          docKey: 'k',
          pdfUrl: 'https://arxiv.org/pdf/1',
          paperId: 'p1',
          kind: 'highlight',
          page: 4,
          rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }],
          x: 0,
          y: 0,
          text: 'quoted',
          color: 'yellow',
          note: '',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });
    expect(patch.annotations).toEqual([
      {
        id: 'a',
        docKey: 'k',
        docUrl: 'https://arxiv.org/pdf/1',
        paperId: 'p1',
        kind: 'highlight',
        anchor: {
          kind: 'pdf',
          page: 4,
          rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }],
          x: 0,
          y: 0,
        },
        text: 'quoted',
        color: 'yellow',
        note: '',
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
  });

  it('leaves annotations alone when there were none', () => {
    expect(v7Patch({ pdfAnnotations: [] }).annotations).toBeUndefined();
  });

  it('returns nothing for a profile with none of the dead keys', () => {
    expect(v7Patch({})).toEqual({});
  });
});
