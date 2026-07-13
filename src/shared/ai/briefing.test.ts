import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../storage';
import type { Task } from '../types';
import { BRIEFING_MAX_CHARS, buildBriefingPrompt, templateBriefing } from './briefing';
import type { AssistantContextData } from './context';

const NOW = new Date(2026, 6, 11, 8, 0, 0);

function task(id: string, text: string): Task {
  return { id, text, createdAt: 0, completedAt: null, snoozedUntil: null, source: 'newtab' };
}

function data(): AssistantContextData {
  return {
    tasks: [],
    streaks: { currentStreak: 0, longestStreak: 0, lastQualifiedDate: '', daily: {}, freezeTokens: 0 },
    gym: { checkins: {}, currentWeekStreak: 0, longestWeekStreak: 0, lastQualifiedWeek: '' },
    gamification: {
      xp: 0,
      badges: {},
      lastQuestCelebratedWeek: '',
      counters: {
        workouts: 0,
        articlesFinished: 0,
        videosFinished: 0,
        sprints: 0,
        tasksCompleted: 0,
        brainDumps: 0,
        focusBlocks: 0,
        cardsReviewed: 0,
        chestsOpened: 0,
      },
    },
    flashCards: [],
    srsDaily: {},
    papers: [],
    siteTime: { date: '', hosts: {} },
    readingProgress: {},
    settings: DEFAULT_SETTINGS,
  };
}

describe('templateBriefing', () => {
  it('always produces text, even on empty data', () => {
    const out = templateBriefing(data(), NOW);
    expect(out.length).toBeGreaterThan(10);
    expect(out.length).toBeLessThanOrEqual(BRIEFING_MAX_CHARS);
  });

  it('mentions the streak and the first open task', () => {
    const d = data();
    d.streaks.currentStreak = 6;
    d.tasks = [task('1', 'Email advisor'), task('2', 'Other')];
    const out = templateBriefing(d, NOW);
    expect(out).toContain('6-day reading streak');
    expect(out).toContain('2 tasks open');
    expect(out).toContain('Email advisor');
  });

  it('flags the gym gap only while under target', () => {
    const d = data();
    expect(templateBriefing(d, NOW)).toContain('Gym: 0/3');
    d.gym.checkins = { '2026-07-06': 1, '2026-07-08': 1, '2026-07-10': 1 };
    expect(templateBriefing(d, NOW)).not.toContain('Gym:');
  });
});

describe('buildBriefingPrompt', () => {
  it('embeds the data snapshot', () => {
    const prompt = buildBriefingPrompt('Open tasks: none.');
    expect(prompt).toContain('Open tasks: none.');
    expect(prompt).toContain('2-4 warm, concrete sentences');
  });
});
