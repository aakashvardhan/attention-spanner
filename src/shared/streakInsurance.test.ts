import { describe, expect, it } from 'vitest';
import { localDate, daysAgo } from './format';
import {
  bridgeGap,
  FREEZE_EARN_EVERY,
  FREEZE_TOKEN_CAP,
  maybeEarnToken,
  missedDays,
} from './streakInsurance';
import type { Streaks } from './types';

function streaksWith(overrides: Partial<Streaks>): Streaks {
  return {
    currentStreak: 10,
    longestStreak: 10,
    lastQualifiedDate: '2026-07-01',
    daily: {},
    freezeTokens: 0,
    ...overrides,
  };
}

describe('missedDays', () => {
  it('is 0 for same day and adjacent days', () => {
    expect(missedDays('2026-07-05', '2026-07-05')).toBe(0);
    expect(missedDays('2026-07-04', '2026-07-05')).toBe(0);
  });

  it('counts whole days strictly between', () => {
    expect(missedDays('2026-07-03', '2026-07-05')).toBe(1);
    expect(missedDays('2026-06-30', '2026-07-05')).toBe(4);
  });

  it('crosses month boundaries', () => {
    expect(missedDays('2026-06-29', '2026-07-02')).toBe(2);
  });

  it('is 0 for empty or malformed dates', () => {
    expect(missedDays('', '2026-07-05')).toBe(0);
    expect(missedDays('yesterday', '2026-07-05')).toBe(0);
  });
});

describe('bridgeGap', () => {
  it('spends one token per missed day and pulls lastQualifiedDate to yesterday', () => {
    const s = streaksWith({ lastQualifiedDate: '2026-07-02', freezeTokens: 3 });
    const result = bridgeGap(s, '2026-07-05');
    expect(result).toEqual({ bridged: true, tokensSpent: 2 });
    expect(s.freezeTokens).toBe(1);
    expect(s.lastQualifiedDate).toBe('2026-07-04');
  });

  it('bridges exactly when tokens equal missed days', () => {
    const s = streaksWith({ lastQualifiedDate: '2026-07-03', freezeTokens: 1 });
    expect(bridgeGap(s, '2026-07-05').bridged).toBe(true);
    expect(s.freezeTokens).toBe(0);
  });

  it('does nothing when tokens are insufficient', () => {
    const s = streaksWith({ lastQualifiedDate: '2026-07-01', freezeTokens: 2 });
    expect(bridgeGap(s, '2026-07-05')).toEqual({ bridged: false, tokensSpent: 0 });
    expect(s.freezeTokens).toBe(2);
    expect(s.lastQualifiedDate).toBe('2026-07-01');
  });

  it('does nothing without a gap or without a live streak', () => {
    expect(bridgeGap(streaksWith({ lastQualifiedDate: '2026-07-04', freezeTokens: 3 }), '2026-07-05').bridged).toBe(false);
    expect(bridgeGap(streaksWith({ currentStreak: 0, lastQualifiedDate: '2026-07-01', freezeTokens: 3 }), '2026-07-05').bridged).toBe(false);
  });

  it('treats missing freezeTokens as 0 (pre-Phase-15 profiles)', () => {
    const s = streaksWith({ lastQualifiedDate: '2026-07-02' });
    delete s.freezeTokens;
    expect(bridgeGap(s, '2026-07-05').bridged).toBe(false);
  });

  it('defaults today to the current local date', () => {
    const s = streaksWith({ lastQualifiedDate: localDate(daysAgo(3)), freezeTokens: 2 });
    expect(bridgeGap(s)).toEqual({ bridged: true, tokensSpent: 2 });
    expect(s.lastQualifiedDate).toBe(localDate(daysAgo(1)));
  });
});

describe('maybeEarnToken', () => {
  it('banks a token exactly on multiples of FREEZE_EARN_EVERY', () => {
    const s = streaksWith({ currentStreak: FREEZE_EARN_EVERY, freezeTokens: 0 });
    expect(maybeEarnToken(s)).toBe(true);
    expect(s.freezeTokens).toBe(1);

    s.currentStreak = FREEZE_EARN_EVERY + 1;
    expect(maybeEarnToken(s)).toBe(false);
    expect(s.freezeTokens).toBe(1);

    s.currentStreak = FREEZE_EARN_EVERY * 2;
    expect(maybeEarnToken(s)).toBe(true);
    expect(s.freezeTokens).toBe(2);
  });

  it('respects the cap', () => {
    const s = streaksWith({ currentStreak: FREEZE_EARN_EVERY, freezeTokens: FREEZE_TOKEN_CAP });
    expect(maybeEarnToken(s)).toBe(false);
    expect(s.freezeTokens).toBe(FREEZE_TOKEN_CAP);
  });

  it('never earns on a dead streak', () => {
    const s = streaksWith({ currentStreak: 0, freezeTokens: 0 });
    expect(maybeEarnToken(s)).toBe(false);
  });
});
