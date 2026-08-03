import { describe, expect, it } from 'vitest';
import {
  DAILY_BRAIN_DUMP_MIN_VISIBLE_CHARS,
  DAILY_GATE_ALLOW_DNR_ID,
  DAILY_GATE_ALLOW_PRIORITY,
  DAILY_GATE_DNR_ID,
  DAILY_GATE_REDIRECT_PRIORITY,
} from './constants';
import {
  basicBrainDumpBullets,
  buildDailyGateAllowRule,
  buildDailyGateRedirectRule,
  gateStateForDate,
  isDailyBrainDumpComplete,
  nextLocalMidnight,
  qualifiesDailyBrainDump,
  safeOriginalUrl,
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

describe('daily DNR rules', () => {
  it('builds the persistent all-web redirect with the original URL in the fragment', () => {
    const rule = buildDailyGateRedirectRule('chrome-extension://id/daily.html');
    expect(rule.id).toBe(DAILY_GATE_DNR_ID);
    expect(rule.priority).toBe(DAILY_GATE_REDIRECT_PRIORITY);
    expect(rule.condition.resourceTypes).toEqual(['main_frame']);
    expect(rule.action.redirect?.regexSubstitution).toBe(
      'chrome-extension://id/daily.html#\\0',
    );
  });

  it('builds a higher-priority session allow', () => {
    const rule = buildDailyGateAllowRule();
    expect(rule.id).toBe(DAILY_GATE_ALLOW_DNR_ID);
    expect(rule.priority).toBe(DAILY_GATE_ALLOW_PRIORITY);
    expect(rule.action.type).toBe('allow');
  });
});

describe('safeOriginalUrl', () => {
  it('allows only http and https destinations', () => {
    expect(safeOriginalUrl('#https://example.com/a#b')?.href).toBe('https://example.com/a#b');
    expect(safeOriginalUrl('http://localhost:3000/')).not.toBeNull();
    expect(safeOriginalUrl('#javascript:alert(1)')).toBeNull();
    expect(safeOriginalUrl('#chrome://settings')).toBeNull();
    expect(safeOriginalUrl('#not a url')).toBeNull();
  });
});
