import { describe, expect, it } from 'vitest';
import { CALENDAR_DEFAULTS } from '../calendar';
import { DEFAULT_SETTINGS } from '../storage';
import type { DayPlan, Task } from '../types';
import type { AssistantContextData } from './context';
import {
  addMinutes,
  buildDayPlanSchema,
  buildPlanPrompt,
  describePlan,
  MAX_PRIORITIES,
  mergePlanReply,
  templateDayPlan,
} from './dayPlan';

const NOW = new Date(2026, 6, 11, 8, 0, 0); // Sat 11 Jul 2026, 08:00 local

function task(id: string, text: string, createdAt = 0): Task {
  return { id, text, createdAt, completedAt: null, snoozedUntil: null, source: 'newtab' };
}

function data(): AssistantContextData {
  return {
    tasks: [],
    streaks: { currentStreak: 0, longestStreak: 0, lastQualifiedDate: '', daily: {}, freezeTokens: 0 },
    gym: { checkins: {}, currentWeekStreak: 0, longestWeekStreak: 0, lastQualifiedWeek: '' },
    gamification: {
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
    },
    flashCards: [],
    srsDaily: {},
    papers: [],
    siteTime: { date: '', hosts: {} },
    readingProgress: {},
    settings: DEFAULT_SETTINGS,
    calendar: { ...CALENDAR_DEFAULTS },
    assistantMemory: [],
    assistantProfile: { text: '', updatedAt: 0 },
    assistantJournal: {},
    feedUnread: { count: 0, topTitles: [] },
  };
}

describe('addMinutes', () => {
  it('adds within the day', () => {
    expect(addMinutes('09:00', 90)).toBe('10:30');
    expect(addMinutes('09:45', 30)).toBe('10:15');
  });

  it('clamps rather than wrapping past midnight', () => {
    expect(addMinutes('23:30', 90)).toBe('23:59');
  });
});

describe('templateDayPlan', () => {
  it('produces an empty but valid plan with no tasks', () => {
    const plan = templateDayPlan(data(), NOW);
    expect(plan.date).toBe('2026-07-11');
    expect(plan.priorities).toEqual([]);
    expect(plan.blocks).toEqual([]);
    expect(plan.reviewedAt).toBeNull();
  });

  it('takes the oldest open tasks, capped', () => {
    const d = data();
    d.tasks = [
      task('new', 'Newest', 500),
      task('old', 'Oldest', 100),
      task('mid', 'Middle', 300),
      task('extra', 'Fourth', 400),
    ];
    const plan = templateDayPlan(d, NOW);
    expect(plan.priorities).toHaveLength(MAX_PRIORITIES);
    expect(plan.priorities.map((p) => p.text)).toEqual(['Oldest', 'Middle', 'Fourth']);
    expect(plan.priorities[0].taskId).toBe('old');
  });

  it('skips completed and still-snoozed tasks', () => {
    const d = data();
    d.tasks = [
      { ...task('done', 'Finished', 1), completedAt: 5 },
      { ...task('snoozed', 'Later', 2), snoozedUntil: NOW.getTime() + 60_000 },
      { ...task('past', 'Woke up', 3), snoozedUntil: NOW.getTime() - 60_000 },
      task('open', 'Open one', 4),
    ];
    expect(templateDayPlan(d, NOW).priorities.map((p) => p.text)).toEqual(['Woke up', 'Open one']);
  });

  it('adds a deep-work block anchored on the first priority', () => {
    const d = data();
    d.tasks = [task('a', 'Write the intro')];
    const plan = templateDayPlan(d, NOW);
    const deep = plan.blocks.find((b) => b.source === 'plan');
    expect(deep).toEqual({
      start: '09:00',
      end: '10:30',
      label: 'Deep work: Write the intro',
      source: 'plan',
    });
  });

  it('anchors deep work on the prime-time peak once the ledger has a sample', () => {
    const d = data();
    d.tasks = [task('a', 'Write the intro')];
    // Enough points, all in the evening, so the peak is unambiguous
    for (let i = 0; i < 10; i++) {
      d.streaks.daily[`2026-07-${String(i + 1).padStart(2, '0')}`] = {
        minutes: 0,
        sprints: 0,
        articlesFinished: 0,
        hours: { '19': 20, '20': 20, '21': 20 },
      };
    }
    const deep = templateDayPlan(d, NOW).blocks.find((b) => b.source === 'plan');
    expect(deep!.start).toBe('19:00');
  });

  it('mirrors timed calendar events and sorts blocks by start', () => {
    const d = data();
    d.tasks = [task('a', 'Write')];
    d.calendar.connected = true;
    d.calendar.events = [
      {
        id: 'e1',
        title: 'Standup',
        startMs: new Date(2026, 6, 11, 14, 0).getTime(),
        endMs: new Date(2026, 6, 11, 14, 30).getTime(),
        allDay: false,
        location: '',
        htmlLink: '',
        hangoutLink: '',
      },
      {
        id: 'e2',
        title: 'Holiday',
        startMs: new Date(2026, 6, 11, 0, 0).getTime(),
        endMs: new Date(2026, 6, 12, 0, 0).getTime(),
        allDay: true,
        location: '',
        htmlLink: '',
        hangoutLink: '',
      },
    ];
    const plan = templateDayPlan(d, NOW);
    expect(plan.blocks.map((b) => b.label)).toEqual(['Deep work: Write', 'Standup']);
    expect(plan.blocks.some((b) => b.label === 'Holiday')).toBe(false);
  });

  it('ignores calendar events while disconnected', () => {
    const d = data();
    d.calendar.events = [
      {
        id: 'e1',
        title: 'Ghost',
        startMs: new Date(2026, 6, 11, 14, 0).getTime(),
        endMs: new Date(2026, 6, 11, 15, 0).getTime(),
        allDay: false,
        location: '',
        htmlLink: '',
        hangoutLink: '',
      },
    ];
    expect(templateDayPlan(d, NOW).blocks).toEqual([]);
  });
});

describe('mergePlanReply', () => {
  const base: DayPlan = {
    date: '2026-07-11',
    priorities: [{ text: 'Old one', taskId: 't1', estimateMin: 30, done: false }],
    blocks: [{ start: '09:00', end: '10:30', label: 'Deep work: Old one', source: 'plan' }],
    generatedAt: 1,
    reviewedAt: null,
    reflection: '',
  };

  it('keeps the template plan on unparseable output', () => {
    expect(mergePlanReply(base, 'not json', [])).toBe(base);
    expect(mergePlanReply(base, '{"nope":1}', [])).toBe(base);
    expect(mergePlanReply(base, '{"priorities":[]}', [])).toBe(base);
  });

  it('replaces priorities and relinks matching tasks by text', () => {
    const tasks = [task('t9', 'Email the advisor')];
    const out = mergePlanReply(
      base,
      JSON.stringify({
        priorities: [
          { text: 'Email the advisor', estimateMin: 15 },
          { text: 'Draft the abstract', estimateMin: 60 },
        ],
      }),
      tasks,
    );
    expect(out.priorities).toEqual([
      { text: 'Email the advisor', taskId: 't9', estimateMin: 15, done: false },
      { text: 'Draft the abstract', taskId: null, estimateMin: 60, done: false },
    ]);
  });

  it('relabels the deep-work block to the new first priority', () => {
    const out = mergePlanReply(
      base,
      JSON.stringify({ priorities: [{ text: 'Draft the abstract', estimateMin: 60 }] }),
      [],
    );
    expect(out.blocks[0].label).toBe('Deep work: Draft the abstract');
  });

  it('clamps estimates and drops empty text', () => {
    const out = mergePlanReply(
      base,
      JSON.stringify({
        priorities: [
          { text: '  ', estimateMin: 30 },
          { text: 'Way too long', estimateMin: 9999 },
          { text: 'Too short', estimateMin: 1 },
          { text: 'No estimate' },
        ],
      }),
      [],
    );
    expect(out.priorities.map((p) => [p.text, p.estimateMin])).toEqual([
      ['Way too long', 240],
      ['Too short', 5],
      ['No estimate', 30],
    ]);
  });

  it('takes at most MAX_PRIORITIES', () => {
    const out = mergePlanReply(
      base,
      JSON.stringify({
        priorities: Array.from({ length: 8 }, (_, i) => ({ text: `P${i}`, estimateMin: 10 })),
      }),
      [],
    );
    expect(out.priorities).toHaveLength(MAX_PRIORITIES);
  });
});

describe('describePlan', () => {
  it('says so when there is nothing to do', () => {
    const plan = templateDayPlan(data(), NOW);
    expect(describePlan(plan)).toContain('Nothing on the list');
  });

  it('lists priorities with estimates and the block count', () => {
    const d = data();
    d.tasks = [task('a', 'Write the intro')];
    const out = describePlan(templateDayPlan(d, NOW));
    expect(out).toContain('Write the intro (30m)');
    expect(out).toContain('1 block on the schedule.');
  });
});

describe('buildPlanPrompt / buildDayPlanSchema', () => {
  it('embeds the snapshot and forbids invention', () => {
    const prompt = buildPlanPrompt('Open tasks: none.');
    expect(prompt).toContain('Open tasks: none.');
    expect(prompt).toContain('Never invent');
  });

  it('caps the schema at MAX_PRIORITIES', () => {
    const schema = buildDayPlanSchema() as {
      properties: { priorities: { maxItems: number } };
    };
    expect(schema.properties.priorities.maxItems).toBe(MAX_PRIORITIES);
  });
});
