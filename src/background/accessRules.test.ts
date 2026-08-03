import { describe, expect, it } from 'vitest';
import { FOCUS_DNR_ID_BASE, FOCUS_DNR_PRIORITY } from '../shared/constants';
import type { FocusSession } from '../shared/types';
import { buildSessionAccessRules } from './accessRules';

/**
 * Focus blocking is the only session rule left. The daily gate used to install
 * a browser-wide redirect here with an allow rule layered under Focus; both are
 * gone, so what remains to pin down is that a Focus session blocks exactly
 * while it is running, and never a moment longer.
 */

const focus: FocusSession = {
  mode: 'oneshot',
  phase: 'focus',
  startedAt: 1,
  phaseEndsAt: Date.now() + 60_000,
  focusMinutes: 25,
  breakMinutes: 5,
  completedBlocks: 0,
};

const build = (focusSession: FocusSession | null) =>
  buildSessionAccessRules({
    focusSession,
    focusDomains: ['netflix.com'],
    focusRedirectUrl: 'chrome-extension://id/blocked.html',
  });

describe('session access rule matrix', () => {
  it('installs nothing when no Focus session is running', () => {
    expect(build(null)).toEqual([]);
  });

  it('redirects the blocklist during a Focus phase', () => {
    const rules = build(focus);
    expect(rules.map((rule) => rule.id)).toEqual([FOCUS_DNR_ID_BASE]);
    expect(rules[0].priority).toBe(FOCUS_DNR_PRIORITY);
  });

  it('stops blocking during a Pomodoro break', () => {
    expect(build({ ...focus, phase: 'break' })).toEqual([]);
  });

  it('does not resurrect an expired Focus phase while rebuilding access', () => {
    expect(build({ ...focus, phaseEndsAt: Date.now() - 1 })).toEqual([]);
  });
});
