import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../storage';
import type { Task } from '../types';
import { buildDataContext, MAX_CONTEXT_CHARS, type AssistantContextData } from './context';

const NOW = new Date(2026, 6, 11, 10, 0, 0); // Sat Jul 11 2026 local

function task(id: string, text: string, completedAt: number | null = null): Task {
  return { id, text, createdAt: 0, completedAt, snoozedUntil: null, source: 'newtab' };
}

function emptyData(): AssistantContextData {
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
    calendar: { connected: false, email: '', events: [], fetchedAt: 0, lastError: '' },
    assistantMemory: [],
    feedUnread: { count: 0, topTitles: [] },
  };
}

describe('buildDataContext', () => {
  it('renders a sane snapshot for empty data', () => {
    const out = buildDataContext(emptyData(), NOW);
    expect(out).toContain('July 11');
    expect(out).toContain('Open tasks: none');
    expect(out).toContain('Reading streak: 0 days');
    expect(out).toContain('Flashcards due now: 0');
  });

  it('lists open tasks and skips completed ones', () => {
    const data = emptyData();
    data.tasks = [task('1', 'Email advisor'), task('2', 'Old thing', 5)];
    const out = buildDataContext(data, NOW);
    expect(out).toContain('Open tasks (1)');
    expect(out).toContain('Email advisor');
    expect(out).not.toContain('Old thing');
  });

  it('includes streak, gym, and level numbers', () => {
    const data = emptyData();
    data.streaks.currentStreak = 7;
    data.streaks.daily['2026-07-11'] = { minutes: 22, sprints: 1, articlesFinished: 0 };
    data.gym.checkins['2026-07-11'] = 1;
    data.gamification.xp = 350;
    const out = buildDataContext(data, NOW);
    expect(out).toContain('Reading streak: 7 days');
    expect(out).toContain('Today: 22 min read');
    expect(out).toContain('1/3 sessions this week');
    expect(out).toContain('checked in today');
    expect(out).toContain('Level 3');
  });

  it('reports today site time but not stale days', () => {
    const data = emptyData();
    data.siteTime = { date: '2026-07-11', hosts: { 'youtube.com': 1800 } };
    expect(buildDataContext(data, NOW)).toContain('youtube.com 30m');

    data.siteTime.date = '2026-07-10';
    expect(buildDataContext(data, NOW)).not.toContain('youtube.com');
  });

  it('includes calendar lines only when connected', () => {
    const data = emptyData();
    expect(buildDataContext(data, NOW)).not.toContain('Calendar');

    data.calendar.connected = true;
    data.calendar.events = [
      {
        id: 'e1',
        title: 'Standup',
        startMs: new Date(2026, 6, 11, 10, 0).getTime(),
        endMs: new Date(2026, 6, 11, 10, 30).getTime(),
        allDay: false,
        location: '',
        htmlLink: '',
        hangoutLink: '',
      },
    ];
    const out = buildDataContext(data, NOW);
    expect(out).toContain('Calendar today (1 event)');
    expect(out).toContain('Standup');
  });

  it('mentions unread articles only when there are some', () => {
    const data = emptyData();
    expect(buildDataContext(data, NOW)).not.toContain('Unread articles');

    data.feedUnread = { count: 12, topTitles: ['Big News', 'Other Story'] };
    const out = buildDataContext(data, NOW);
    expect(out).toContain('Unread articles: 12 — newest: “Big News”, “Other Story”.');
  });

  it('lists remembered facts newest-first', () => {
    const data = emptyData();
    expect(buildDataContext(data, NOW)).not.toContain('remember');

    data.assistantMemory = [
      { id: 'a', text: 'My advisor is Dr. Lee', createdAt: 1, updatedAt: 1 },
      { id: 'b', text: 'I lift Mon/Wed/Fri', createdAt: 2, updatedAt: 2 },
    ];
    const out = buildDataContext(data, NOW);
    expect(out).toContain('Things the user asked you to remember:');
    expect(out.indexOf('I lift Mon/Wed/Fri')).toBeLessThan(out.indexOf('My advisor is Dr. Lee'));
  });

  it('caps the snapshot length', () => {
    const data = emptyData();
    data.tasks = Array.from({ length: 200 }, (_, i) => task(`${i}`, `Task ${'x'.repeat(200)} ${i}`));
    expect(buildDataContext(data, NOW).length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  });
});
