import { describe, expect, it } from 'vitest';
import { JOURNAL_ENTRY_MAX_CHARS, JOURNAL_MAX_ENTRIES_PER_DAY } from '../constants';
import type { DayPlan, JournalDay } from '../types';
import {
  appendEntry,
  daysInRange,
  journalContextLines,
  patchPlan,
  pruneJournal,
  setPlan,
  type Journal,
} from './journal';

/** Noon local, so a test never straddles a date boundary via UTC. */
function at(date: string, hour = 12): number {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:00:00`).getTime();
}

function plan(date: string, overrides: Partial<DayPlan> = {}): DayPlan {
  return {
    date,
    priorities: [],
    blocks: [],
    generatedAt: at(date),
    reviewedAt: null,
    reflection: '',
    ...overrides,
  };
}

function day(date: string, overrides: Partial<JournalDay> = {}): JournalDay {
  return { date, plan: null, entries: [], ...overrides };
}

describe('appendEntry', () => {
  it('creates the day and trims the text', () => {
    const j = appendEntry({}, 'note', '  ran   a  sprint ', at('2026-07-20'));
    expect(Object.keys(j)).toEqual(['2026-07-20']);
    expect(j['2026-07-20'].entries[0].text).toBe('ran a sprint');
    expect(j['2026-07-20'].plan).toBeNull();
  });

  it('ignores empty text', () => {
    const j: Journal = {};
    expect(appendEntry(j, 'note', '   ', at('2026-07-20'))).toBe(j);
  });

  it('caps entry length', () => {
    const j = appendEntry({}, 'digest', 'x'.repeat(JOURNAL_ENTRY_MAX_CHARS + 50), at('2026-07-20'));
    expect(j['2026-07-20'].entries[0].text).toHaveLength(JOURNAL_ENTRY_MAX_CHARS);
  });

  it('keeps the newest entries once a day is full', () => {
    let j: Journal = {};
    for (let i = 0; i < JOURNAL_MAX_ENTRIES_PER_DAY + 5; i++) {
      j = appendEntry(j, 'action', `entry ${i}`, at('2026-07-20'));
    }
    const entries = j['2026-07-20'].entries;
    expect(entries).toHaveLength(JOURNAL_MAX_ENTRIES_PER_DAY);
    expect(entries[0].text).toBe('entry 5');
    expect(entries.at(-1)!.text).toBe(`entry ${JOURNAL_MAX_ENTRIES_PER_DAY + 4}`);
  });

  it('leaves an existing plan alone', () => {
    const j = appendEntry(setPlan({}, plan('2026-07-20')), 'note', 'hello', at('2026-07-20'));
    expect(j['2026-07-20'].plan).not.toBeNull();
    expect(j['2026-07-20'].entries).toHaveLength(1);
  });
});

describe('patchPlan', () => {
  it('patches without disturbing entries', () => {
    const seeded = appendEntry(setPlan({}, plan('2026-07-20')), 'note', 'hi', at('2026-07-20'));
    const j = patchPlan(seeded, '2026-07-20', { reflection: 'slow morning' });
    expect(j['2026-07-20'].plan!.reflection).toBe('slow morning');
    expect(j['2026-07-20'].entries).toHaveLength(1);
  });

  it('is a no-op when the day has no plan', () => {
    const j: Journal = { '2026-07-20': day('2026-07-20') };
    expect(patchPlan(j, '2026-07-20', { reflection: 'x' })).toBe(j);
    expect(patchPlan(j, '2026-07-21', { reflection: 'x' })).toBe(j);
  });
});

describe('pruneJournal', () => {
  it('drops days past the retention window and keeps the boundary', () => {
    const now = at('2026-07-26');
    const j: Journal = {
      '2026-01-01': day('2026-01-01'),
      '2026-05-27': day('2026-05-27'), // exactly 60 days back
      '2026-07-25': day('2026-07-25'),
    };
    const kept = pruneJournal(j, now);
    expect(Object.keys(kept).sort()).toEqual(['2026-05-27', '2026-07-25']);
  });
});

describe('daysInRange', () => {
  it('returns the inclusive range, oldest first', () => {
    const j: Journal = {
      '2026-07-22': day('2026-07-22'),
      '2026-07-20': day('2026-07-20'),
      '2026-07-19': day('2026-07-19'),
    };
    expect(daysInRange(j, '2026-07-20', '2026-07-22').map((d) => d.date)).toEqual([
      '2026-07-20',
      '2026-07-22',
    ]);
  });
});

describe('journalContextLines', () => {
  const now = new Date(at('2026-07-26'));

  it('is empty when yesterday has no record', () => {
    expect(journalContextLines({}, now)).toEqual([]);
  });

  it('reports planned vs finished, the reflection, and action count', () => {
    let j = setPlan({}, {
      ...plan('2026-07-25', {
        priorities: [
          { text: 'a', taskId: null, estimateMin: 30, done: true },
          { text: 'b', taskId: null, estimateMin: 30, done: false },
        ],
        reflection: 'meetings ate it',
      }),
    });
    j = appendEntry(j, 'action', 'added a task', at('2026-07-25'));
    j = appendEntry(j, 'briefing', 'morning line', at('2026-07-25'));

    const [line] = journalContextLines(j, now);
    expect(line).toContain('planned 2, finished 1');
    expect(line).toContain('meetings ate it');
    expect(line).toContain('1 action run');
  });

  it('reports actions alone when there was no plan', () => {
    const j = appendEntry({}, 'action', 'completed a task', at('2026-07-25'));
    expect(journalContextLines(j, now)).toEqual([
      'Yesterday (2026-07-25): 1 action run.',
    ]);
  });
});
