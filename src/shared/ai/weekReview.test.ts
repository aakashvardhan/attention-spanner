import { describe, expect, it } from 'vitest';
import type { DayPlan, Gamification, GymState, Streaks } from '../types';
import type { Journal } from './journal';
import type { LooseEnd } from './looseEnds';
import {
  buildReviewPrompt,
  buildReviewSchema,
  buildWeekSummary,
  formatWeekSummary,
  MAX_NEXT_PRIORITIES,
  parseReviewReply,
  REVIEW_MAX_CHARS,
  templateReview,
  type WeekReviewData,
} from './weekReview';

const KEY = '2026-07-20'; // Monday

function plan(date: string, done: number, total: number, overrides: Partial<DayPlan> = {}): DayPlan {
  return {
    date,
    priorities: Array.from({ length: total }, (_, i) => ({
      text: `P${i}`,
      taskId: null,
      estimateMin: 30,
      done: i < done,
    })),
    blocks: [],
    generatedAt: 0,
    reviewedAt: null,
    reflection: '',
    ...overrides,
  };
}

function streaks(): Streaks {
  return { currentStreak: 0, longestStreak: 0, lastQualifiedDate: '', daily: {}, freezeTokens: 0 };
}

function gym(): GymState {
  return { checkins: {}, currentWeekStreak: 0, longestWeekStreak: 0, lastQualifiedWeek: '' };
}

function gamification(): Gamification {
  return {
    badges: {},
    counters: {
      workouts: 0,
      articlesFinished: 0,
      videosFinished: 0,
      sprints: 0,
      tasksCompleted: 0,
      brainDumps: 0,
      focusBlocks: 0,
      cardsReviewed: 0,
      freezesEarned: 0,
    },
  };
}

function data(overrides: Partial<WeekReviewData> = {}): WeekReviewData {
  return {
    journal: {},
    streaks: streaks(),
    gym: gym(),
    gamification: gamification(),
    gymWeeklyTarget: 3,
    looseEnds: [],
    ...overrides,
  };
}

describe('buildWeekSummary', () => {
  it('reports zeros for an empty week', () => {
    const summary = buildWeekSummary(data(), KEY);
    expect(summary).toMatchObject({
      weekKey: KEY,
      daysPlanned: 0,
      prioritiesPlanned: 0,
      prioritiesDone: 0,
      daysClosedOut: 0,
      readingMinutes: 0,
      tasksCompleted: 0,
      actionsRun: 0,
    });
  });

  it('counts plans, completions and close-outs across the week', () => {
    const journal: Journal = {
      '2026-07-20': { date: '2026-07-20', plan: plan('2026-07-20', 2, 3), entries: [] },
      '2026-07-22': {
        date: '2026-07-22',
        plan: plan('2026-07-22', 1, 2, { reviewedAt: 5, reflection: 'meetings ate it' }),
        entries: [],
      },
    };
    const summary = buildWeekSummary(data({ journal }), KEY);
    expect(summary.daysPlanned).toBe(2);
    expect(summary.prioritiesPlanned).toBe(5);
    expect(summary.prioritiesDone).toBe(3);
    expect(summary.daysClosedOut).toBe(1);
    expect(summary.reflections).toEqual(['meetings ate it']);
  });

  it('ignores days outside the week', () => {
    const journal: Journal = {
      '2026-07-19': { date: '2026-07-19', plan: plan('2026-07-19', 3, 3), entries: [] }, // Sun before
      '2026-07-27': { date: '2026-07-27', plan: plan('2026-07-27', 3, 3), entries: [] }, // Mon after
      '2026-07-26': { date: '2026-07-26', plan: plan('2026-07-26', 1, 1), entries: [] }, // Sun in week
    };
    const summary = buildWeekSummary(data({ journal }), KEY);
    expect(summary.daysPlanned).toBe(1);
    expect(summary.prioritiesDone).toBe(1);
  });

  it('counts only action entries', () => {
    const journal: Journal = {
      '2026-07-21': {
        date: '2026-07-21',
        plan: null,
        entries: [
          { id: '1', at: 0, kind: 'action', text: 'added a task' },
          { id: '2', at: 0, kind: 'action', text: 'started a focus' },
          { id: '3', at: 0, kind: 'briefing', text: 'morning' },
        ],
      },
    };
    expect(buildWeekSummary(data({ journal }), KEY).actionsRun).toBe(2);
  });

  it('sums reading stats and reads the gym week', () => {
    const s = streaks();
    s.daily['2026-07-20'] = { minutes: 30.4, sprints: 2, articlesFinished: 1, tasksCompleted: 3 };
    s.daily['2026-07-23'] = { minutes: 10.2, sprints: 1, articlesFinished: 0, tasksCompleted: 1 };
    const g = gym();
    g.checkins = { '2026-07-21': 1, '2026-07-24': 1 };
    const summary = buildWeekSummary(data({ streaks: s, gym: g }), KEY);
    expect(summary.readingMinutes).toBe(40); // 30 + 10, each rounded
    expect(summary.sprints).toBe(3);
    expect(summary.tasksCompleted).toBe(4);
    expect(summary.gymSessions).toBe(2);
    expect(summary.gymTarget).toBe(3);
  });
});

describe('templateReview', () => {
  it('says plainly when nothing was planned', () => {
    const out = templateReview(buildWeekSummary(data(), KEY));
    expect(out).toContain('No day plans this week');
    expect(out.length).toBeLessThanOrEqual(REVIEW_MAX_CHARS);
  });

  it('states the completion rate', () => {
    const journal: Journal = {
      '2026-07-20': { date: '2026-07-20', plan: plan('2026-07-20', 1, 4), entries: [] },
    };
    expect(templateReview(buildWeekSummary(data({ journal }), KEY))).toContain(
      'finished 1 of 4 priorities (25%)',
    );
  });

  it('names the oldest stalled item', () => {
    const looseEnds: LooseEnd[] = [
      { kind: 'paper', label: '“Old paper” — stopped at 20%', staleDays: 40, url: '' },
      { kind: 'task', label: '“Something”', staleDays: 31, url: '' },
    ];
    const out = templateReview(buildWeekSummary(data({ looseEnds }), KEY));
    expect(out).toContain('2 things stalled');
    expect(out).toContain('Old paper');
    expect(out).toContain('(40d)');
  });
});

describe('formatWeekSummary', () => {
  it('lays out the counted figures the model may use', () => {
    const journal: Journal = {
      '2026-07-20': {
        date: '2026-07-20',
        plan: plan('2026-07-20', 2, 3, { reviewedAt: 1, reflection: 'good morning, dead afternoon' }),
        entries: [],
      },
    };
    const out = formatWeekSummary(buildWeekSummary(data({ journal }), KEY));
    expect(out).toContain('Week of 2026-07-20.');
    expect(out).toContain('Priorities: 2 done of 3 planned.');
    expect(out).toContain('Days planned: 1/7; days closed out: 1.');
    expect(out).toContain('- good morning, dead afternoon');
    expect(out).toContain('Nothing stalled');
  });
});

describe('parseReviewReply', () => {
  it('falls back to the template on unparseable output', () => {
    expect(parseReviewReply('not json', 'fallback text')).toEqual({
      summary: 'fallback text',
      priorities: [],
    });
  });

  it('falls back when the summary is empty but keeps priorities', () => {
    const out = parseReviewReply(JSON.stringify({ summary: '  ', priorities: ['Do X'] }), 'fb');
    expect(out.summary).toBe('fb');
    expect(out.priorities).toEqual(['Do X']);
  });

  it('takes the summary and caps priorities', () => {
    const out = parseReviewReply(
      JSON.stringify({
        summary: 'Two of five priorities landed.',
        priorities: ['A', '', 'B', 'C', 'D'],
      }),
      'fb',
    );
    expect(out.summary).toBe('Two of five priorities landed.');
    expect(out.priorities).toEqual(['A', 'B', 'C'].slice(0, MAX_NEXT_PRIORITIES));
  });
});

describe('buildReviewPrompt / buildReviewSchema', () => {
  it('forbids inventing numbers and embeds the figures', () => {
    const prompt = buildReviewPrompt('Priorities: 2 done of 3 planned.');
    expect(prompt).toContain('Priorities: 2 done of 3 planned.');
    expect(prompt).toContain('never compute, estimate or invent a number');
  });

  it('caps proposed priorities', () => {
    const schema = buildReviewSchema() as {
      properties: { priorities: { maxItems: number } };
    };
    expect(schema.properties.priorities.maxItems).toBe(MAX_NEXT_PRIORITIES);
  });
});
