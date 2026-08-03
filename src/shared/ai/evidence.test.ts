import { describe, expect, it } from 'vitest';
import { CALENDAR_DEFAULTS } from '../calendar';
import { DEFAULT_SETTINGS } from '../storage';
import type { Task } from '../types';
import {
  buildEvidenceBundle,
  evidenceDomains,
  expandEvidenceQuery,
  type EvidenceData,
} from './evidence';

const NOW = new Date(2026, 6, 30, 10, 0, 0);

function task(id: string, text: string): Task {
  return {
    id,
    text,
    createdAt: Number(id) || 0,
    updatedAt: Number(id) || 0,
    completedAt: null,
    snoozedUntil: null,
    source: 'newtab',
  };
}

function emptyData(): EvidenceData {
  return {
    tasks: [],
    streaks: {
      currentStreak: 0,
      longestStreak: 0,
      lastQualifiedDate: '',
      daily: {},
      freezeTokens: 0,
    },
    gym: {
      checkins: {},
      currentWeekStreak: 0,
      longestWeekStreak: 0,
      lastQualifiedWeek: '',
    },
    calendar: structuredClone(CALENDAR_DEFAULTS),
    assistantMemory: [],
    assistantProfile: { text: '', updatedAt: 0 },
    papers: [],
    readingProgress: {},
    assistantJournal: {},
    cachedItems: [],
    readItems: [],
    siteTime: { date: '', hosts: {} },
    settings: DEFAULT_SETTINGS,
    libraryHits: [],
  };
}

describe('evidence routing', () => {
  it('selects only the domains named by a common question', () => {
    expect(evidenceDomains('how many open tasks do I have?')).toEqual(['tasks']);
    expect(evidenceDomains('what is on my calendar and how is my reading streak?')).toEqual([
      'streak',
      'calendar',
      'reading',
    ]);
  });

  it('expands common personal vocabulary without removing the original terms', () => {
    const expanded = expandEvidenceQuery('What did my advisor say about the paper?');
    expect(expanded).toContain('advisor');
    expect(expanded).toContain('supervisor');
    expect(expanded).toContain('paper');
    expect(expanded).toContain('article');
  });
});

describe('buildEvidenceBundle', () => {
  it('answers exact task counts locally with versioned evidence', () => {
    const data = emptyData();
    data.tasks = [task('1', 'Email advisor'), task('2', 'Read chapter')];
    const bundle = buildEvidenceBundle('how many open tasks do I have?', data, NOW);

    expect(bundle.exactAnswer).toBe('You have 2 open tasks.');
    expect(bundle.complete).toBe(true);
    expect(bundle.sources).toHaveLength(1);
    expect(bundle.sources[0]).toMatchObject({ id: 'S1', kind: 'task', title: 'Open tasks' });
    expect(bundle.context).toContain('[S1] Open tasks (2)');
  });

  it('searches all remembered facts and retrieves an old relevant one', () => {
    const data = emptyData();
    data.assistantMemory = Array.from({ length: 50 }, (_, i) => ({
      id: String(i),
      text: i === 0 ? 'My advisor is Dr. Lee' : `Preference number ${i}`,
      createdAt: i,
      updatedAt: i,
    }));
    const bundle = buildEvidenceBundle('what do you remember about my advisor?', data, NOW);

    expect(bundle.context).toContain('My advisor is Dr. Lee');
    expect(bundle.sources.some((source) => source.updatedAt === 0)).toBe(true);
  });

  it('does not use an exact template for a multi-domain question', () => {
    const data = emptyData();
    data.tasks = [task('1', 'Email advisor')];
    data.streaks.currentStreak = 4;
    const bundle = buildEvidenceBundle('how many tasks and what is my streak?', data, NOW);

    expect(bundle.domains).toEqual(['tasks', 'streak']);
    expect(bundle.exactAnswer).toBeUndefined();
    expect(bundle.items.length).toBeGreaterThanOrEqual(2);
  });

  it('changes the evidence version when supporting data changes', () => {
    const data = emptyData();
    data.tasks = [task('1', 'Email advisor')];
    const before = buildEvidenceBundle('show my tasks', data, NOW);
    data.tasks = [...data.tasks, task('2', 'Read chapter')];
    const after = buildEvidenceBundle('show my tasks', data, NOW);

    expect(after.versionHash).not.toBe(before.versionHash);
  });
});
