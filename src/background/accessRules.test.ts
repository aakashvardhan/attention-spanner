import { describe, expect, it } from 'vitest';
import {
  DAILY_GATE_ALLOW_DNR_ID,
  DAILY_GATE_ALLOW_PRIORITY,
  FOCUS_DNR_ID_BASE,
  FOCUS_DNR_PRIORITY,
} from '../shared/constants';
import type { DailyBrainDumpGateState, FocusSession } from '../shared/types';
import { localDate } from '../shared/format';
import { buildSessionAccessRules } from './accessRules';

const complete: DailyBrainDumpGateState = {
  date: localDate(),
  completedAt: Date.now(),
  noteId: 'note',
};
const locked: DailyBrainDumpGateState = { date: '', completedAt: null, noteId: null };
const focus: FocusSession = {
  mode: 'oneshot',
  phase: 'focus',
  startedAt: 1,
  phaseEndsAt: Date.now() + 60_000,
  focusMinutes: 25,
  breakMinutes: 5,
  completedBlocks: 0,
};

const build = (gate: DailyBrainDumpGateState, focusSession: FocusSession | null) =>
  buildSessionAccessRules({
    gate,
    focusSession,
    focusDomains: ['netflix.com'],
    focusRedirectUrl: 'chrome-extension://id/blocked.html',
  });

describe('session access rule matrix', () => {
  it('installs no session rules while the daily gate is locked', () => {
    expect(build(locked, null)).toEqual([]);
    expect(build(locked, focus)).toEqual([]);
  });

  it('allows web browsing after the daily dump', () => {
    const rules = build(complete, null);
    expect(rules.map((rule) => rule.id)).toEqual([DAILY_GATE_ALLOW_DNR_ID]);
    expect(rules[0].priority).toBe(DAILY_GATE_ALLOW_PRIORITY);
  });

  it('layers higher-priority Focus redirects above the daily allow', () => {
    const rules = build(complete, focus);
    expect(rules.map((rule) => rule.id)).toEqual([
      DAILY_GATE_ALLOW_DNR_ID,
      FOCUS_DNR_ID_BASE,
    ]);
    expect(rules[1].priority).toBe(FOCUS_DNR_PRIORITY);
    expect(FOCUS_DNR_PRIORITY).toBeGreaterThan(DAILY_GATE_ALLOW_PRIORITY);
  });

  it('keeps only the daily allow during a Pomodoro break', () => {
    expect(build(complete, { ...focus, phase: 'break' }).map((rule) => rule.id)).toEqual([
      DAILY_GATE_ALLOW_DNR_ID,
    ]);
  });

  it('does not resurrect an expired Focus phase while rebuilding access', () => {
    expect(
      build(complete, { ...focus, phaseEndsAt: Date.now() - 1 }).map((rule) => rule.id),
    ).toEqual([DAILY_GATE_ALLOW_DNR_ID]);
  });
});
