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

const focus: FocusSession = { startedAt: 1, tabIds: [5], title: 'Paper' };

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

  it('installs nothing once the last reader tab is gone', () => {
    expect(build({ ...focus, tabIds: [] })).toEqual([]);
  });

  it('treats a pre-reader (Pomodoro-shaped) session as not blocking', () => {
    expect(build({ startedAt: 1 } as unknown as FocusSession)).toEqual([]);
  });
});
