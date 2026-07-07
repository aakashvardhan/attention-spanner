import { daysAgo, localDate } from './format';
import type { Streaks } from './types';

/**
 * Streak insurance: freeze tokens earned by consistency auto-bridge missed
 * days so one bad day doesn't zero a long streak (all-or-nothing collapse is
 * the top reason streak mechanics stop working for ADHD brains). Pure
 * mutation helpers — callers persist the object.
 */

export const FREEZE_TOKEN_CAP = 3;
/** A token is banked every N-th consecutive qualified day */
export const FREEZE_EARN_EVERY = 5;

function parseLocal(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  // Noon avoids DST-shift off-by-ones when diffing calendar days
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
}

/** Whole calendar days strictly between two local 'YYYY-MM-DD' dates */
export function missedDays(lastQualifiedDate: string, today: string): number {
  const from = parseLocal(lastQualifiedDate);
  const to = parseLocal(today);
  if (!from || !to) return 0;
  const diff = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  return Math.max(0, diff - 1);
}

export interface BridgeResult {
  bridged: boolean;
  tokensSpent: number;
}

/**
 * If the gap since the last qualified day is small enough to cover with
 * available tokens (one token per missed day), spend them and pull
 * lastQualifiedDate to yesterday so the streak reads as unbroken.
 */
export function bridgeGap(streaks: Streaks, today = localDate()): BridgeResult {
  const missed = missedDays(streaks.lastQualifiedDate, today);
  const tokens = streaks.freezeTokens ?? 0;
  if (streaks.currentStreak <= 0 || missed === 0 || missed > tokens) {
    return { bridged: false, tokensSpent: 0 };
  }
  const todayDate = parseLocal(today);
  streaks.freezeTokens = tokens - missed;
  streaks.lastQualifiedDate = localDate(daysAgo(1, todayDate ?? undefined));
  return { bridged: true, tokensSpent: missed };
}

/** Bank a token on every FREEZE_EARN_EVERY-th consecutive day, up to the cap */
export function maybeEarnToken(streaks: Streaks): boolean {
  if (streaks.currentStreak <= 0 || streaks.currentStreak % FREEZE_EARN_EVERY !== 0) {
    return false;
  }
  const tokens = streaks.freezeTokens ?? 0;
  if (tokens >= FREEZE_TOKEN_CAP) return false;
  streaks.freezeTokens = tokens + 1;
  return true;
}
