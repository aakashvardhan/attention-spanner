import { describe, expect, it } from 'vitest';
import {
  DAILY_BRAIN_DUMP_MIN_VISIBLE_CHARS,
} from './constants';
import {
  basicBrainDumpBullets,
  gateStateForDate,
  isDailyBrainDumpComplete,
  nextLocalMidnight,
  qualifiesDailyBrainDump,
  visibleCharacterCount,
} from './dailyBrainDump';
import type { BrainDumpNote } from './types';

function note(overrides: Partial<BrainDumpNote> = {}): BrainDumpNote {
  return {
    id: 'note-1',
    rawText: 'This is a meaningful brain dump',
    status: 'raw',
    bullets: [],
    proposedTasks: [],
    createdAt: new Date(2026, 6, 29, 8).getTime(),
    structuredAt: null,
    ...overrides,
  };
}

describe('daily brain dump qualification', () => {
  it('counts Unicode characters but excludes every kind of whitespace', () => {
    expect(visibleCharacterCount(' ab\n cd\t🙂 ')).toBe(5);
  });

  it('requires the configured number of visible characters', () => {
    expect(qualifiesDailyBrainDump('x'.repeat(DAILY_BRAIN_DUMP_MIN_VISIBLE_CHARS - 1))).toBe(false);
    expect(qualifiesDailyBrainDump('x '.repeat(DAILY_BRAIN_DUMP_MIN_VISIBLE_CHARS))).toBe(true);
  });
});

describe('basicBrainDumpBullets', () => {
  it('turns separate thoughts into a deduplicated offline outline', () => {
    expect(
      basicBrainDumpBullets(
        '- Send the invoice\nCall the dentist\nCall the dentist\nPrepare for the meeting',
      ),
    ).toEqual(['Send the invoice', 'Call the dentist', 'Prepare for the meeting']);
  });

  it('splits a paragraph into sentence bullets when there are no line breaks', () => {
    expect(
      basicBrainDumpBullets('I need groceries. The report is still unfinished! Call Mom?'),
    ).toEqual(['I need groceries.', 'The report is still unfinished!', 'Call Mom?']);
  });
});

describe('daily gate state', () => {
  it('recognizes completion only for the active local date', () => {
    const state = { date: '2026-07-29', completedAt: 10, noteId: 'n' };
    expect(isDailyBrainDumpComplete(state, '2026-07-29')).toBe(true);
    expect(isDailyBrainDumpComplete(state, '2026-07-30')).toBe(false);
  });

  it('grandfathers a qualifying note from today', () => {
    expect(
      gateStateForDate(
        { date: '', completedAt: null, noteId: null },
        [note()],
        '2026-07-29',
      ),
    ).toEqual({
      date: '2026-07-29',
      completedAt: note().createdAt,
      noteId: 'note-1',
    });
  });

  it('heals an incomplete current-day state when its note was already saved', () => {
    expect(
      gateStateForDate(
        { date: '2026-07-29', completedAt: null, noteId: null },
        [note()],
        '2026-07-29',
      ).noteId,
    ).toBe('note-1');
  });

  it('grandfathers an encrypted note without exposing its plaintext', () => {
    const encrypted = note({ rawText: '', encRaw: 'ciphertext' });
    expect(
      gateStateForDate(
        { date: '2026-07-28', completedAt: 1, noteId: 'old' },
        [encrypted],
        '2026-07-29',
      ).noteId,
    ).toBe('note-1');
  });

  it('starts a fresh locked state when no note exists today', () => {
    expect(
      gateStateForDate(
        { date: '2026-07-28', completedAt: 1, noteId: 'old' },
        [note({ createdAt: new Date(2026, 6, 28, 8).getTime() })],
        '2026-07-29',
      ),
    ).toEqual({ date: '2026-07-29', completedAt: null, noteId: null });
  });

  it('calculates the next local midnight across a calendar boundary', () => {
    const now = new Date(2026, 11, 31, 23, 59, 30);
    const next = new Date(nextLocalMidnight(now));
    expect([next.getFullYear(), next.getMonth(), next.getDate(), next.getHours()]).toEqual([
      2027, 0, 1, 0,
    ]);
  });
});

