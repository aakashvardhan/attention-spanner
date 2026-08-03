import { describe, expect, it } from 'vitest';
import {
  v12ReadingProgress,
  v15Skin,
  v16DashboardMode,
  v17DailyBrainDumpGate,
  v18EnabledPacks,
  v7Patch,
} from './storage';

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

describe('v16DashboardMode', () => {
  it('replaces arbitrary layout state with the focused preset', () => {
    expect(
      v16DashboardMode({
        theme: 'dark',
        dashColumns: 4,
        dashCardOrder: ['feeds', 'tasks'],
        dashHiddenCards: ['agenda'],
        dashFullWidthCards: ['feeds'],
      }),
    ).toEqual({ theme: 'dark', dashboardMode: 'focused' });
  });

  it('does not create settings when none were stored', () => {
    expect(v16DashboardMode(undefined)).toBeNull();
  });
});

/**
 * v11 → v12 repairs Continue rows the reader corrupted: entries stamped with
 * the reader page's own title ("Reader") and chrome-extension:// URL.
 */
describe('v12ReadingProgress', () => {
  const entry = (over: Record<string, unknown>) =>
    ({ title: 'A post', url: 'https://example.com/a', maxPercent: 20, ...over }) as never;

  it('restores the article URL from the reader link and drops the "Reader" name', () => {
    const repaired = v12ReadingProgress({
      'example.com/a': entry({
        title: 'Reader',
        url: 'chrome-extension://abc/src/pages/reader/index.html?article=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1',
      }),
    });
    expect(repaired?.['example.com/a']).toMatchObject({
      title: '',
      url: 'https://example.com/a?x=1',
      maxPercent: 20,
    });
  });

  it('handles the PDF reader link too, keeping a real title', () => {
    const repaired = v12ReadingProgress({
      'example.com/p': entry({
        title: 'A paper',
        url: 'chrome-extension://abc/src/pages/reader/index.html?src=https%3A%2F%2Fexample.com%2Fp.pdf',
      }),
    });
    expect(repaired?.['example.com/p']).toMatchObject({
      title: 'A paper',
      url: 'https://example.com/p.pdf',
    });
  });

  it('returns null when nothing is corrupted, so a clean profile is not rewritten', () => {
    expect(v12ReadingProgress({ 'example.com/a': entry({}) })).toBeNull();
    expect(v12ReadingProgress({})).toBeNull();
  });

  it('leaves videos alone', () => {
    expect(
      v12ReadingProgress({
        'yt:abc': entry({ kind: 'video', url: 'https://www.youtube.com/watch?v=abc' }),
      }),
    ).toBeNull();
  });
});

/**
 * v13 → v14 seeds the knowledge graph from whatever reading history survived
 * tracking.prune. Only articles and videos — papers, bookmarks and recordings
 * are reconciled on the first graph open instead.
 */
/*
 * v14 → v15 flips the default skin to Brave. patchSettings writes the whole
 * settings object, so a profile that ever changed any setting has a stored
 * 'auto' that would shadow the new default forever.
 */
describe('v15Skin', () => {
  it('rewrites a stored auto to the new default', () => {
    expect(v15Skin({ skin: 'auto', dailyGoalMinutes: 20 })).toEqual({
      skin: 'brave',
      dailyGoalMinutes: 20,
    });
  });

  it('leaves an explicit skin alone — that is a real choice', () => {
    expect(v15Skin({ skin: 'chrome' })).toBeNull();
    expect(v15Skin({ skin: 'default' })).toBeNull();
    expect(v15Skin({ skin: 'brave' })).toBeNull();
  });

  it('touches nothing when no settings are stored', () => {
    expect(v15Skin(undefined)).toBeNull();
    expect(v15Skin({})).toBeNull();
  });
});

describe('v17DailyBrainDumpGate', () => {
  it('grandfathers a meaningful note already saved on the migration date', () => {
    const createdAt = new Date(2026, 6, 29, 9).getTime();
    expect(
      v17DailyBrainDumpGate(
        [
          {
            id: 'today',
            rawText: 'Enough detail to count as a real dump',
            status: 'raw',
            bullets: [],
            proposedTasks: [],
            createdAt,
            structuredAt: null,
          },
        ],
        undefined,
        '2026-07-29',
      ),
    ).toEqual({ date: '2026-07-29', completedAt: createdAt, noteId: 'today' });
  });

  it('starts locked when the only retained note is from yesterday', () => {
    expect(
      v17DailyBrainDumpGate(
        [
          {
            id: 'old',
            rawText: 'A meaningful but stale dump from the prior day',
            status: 'raw',
            bullets: [],
            proposedTasks: [],
            createdAt: new Date(2026, 6, 28, 9).getTime(),
            structuredAt: null,
          },
        ],
        undefined,
        '2026-07-29',
      ),
    ).toEqual({ date: '2026-07-29', completedAt: null, noteId: null });
  });
});

describe('v18EnabledPacks', () => {
  it('starts a new empty profile with the attention core only', () => {
    expect(v18EnabledPacks({})).toEqual([]);
  });

  it('enables research for surviving research data', () => {
    expect(v18EnabledPacks({ papers: [{}] })).toEqual(['research']);
    expect(v18EnabledPacks({ recordings: [{}] })).toEqual(['research']);
  });

  it('enables work for a connected calendar or Gmail account', () => {
    expect(v18EnabledPacks({ calendar: { connected: true } })).toEqual(['work']);
    expect(
      v18EnabledPacks({
        gmail: {
          clientId: '',
          clientSecret: '',
          triaged: [],
          triagedAt: 0,
          lastError: '',
          accounts: [
            {
              id: 'mail',
              email: 'reader@example.com',
              accessToken: '',
              refreshToken: '',
              expiresAt: 0,
              connected: true,
              lastError: '',
            },
          ],
        },
      }),
    ).toEqual(['work']);
  });

  it('preserves explicit packs and detects the legacy assistant setting', () => {
    expect(
      v18EnabledPacks({
        enabledPacks: ['work'],
        settings: { assistantEnabled: true },
        papers: [{}],
      }),
    ).toEqual(['research', 'work', 'assistant']);
  });
});
