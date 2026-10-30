import { describe, expect, it } from 'vitest';
import { FOCUS_DNR_ID_BASE } from './constants';
import { buildFocusRules, isBlockedHost, nextPhase, normalizeBlockDomain } from './focusRules';
import type { FocusSession } from './types';

describe('normalizeBlockDomain', () => {
  it('passes clean domains through', () => {
    expect(normalizeBlockDomain('netflix.com')).toBe('netflix.com');
    expect(normalizeBlockDomain('mail.google.com')).toBe('mail.google.com');
  });

  it('strips protocol, www, port, and path', () => {
    expect(normalizeBlockDomain('https://www.Netflix.com/browse')).toBe('netflix.com');
    expect(normalizeBlockDomain('http://linkedin.com:443/feed/')).toBe('linkedin.com');
    expect(normalizeBlockDomain('www.hulu.com')).toBe('hulu.com');
  });

  it('lowercases and trims', () => {
    expect(normalizeBlockDomain('  AMAZON.COM  ')).toBe('amazon.com');
  });

  it('keeps meaningful subdomains', () => {
    expect(normalizeBlockDomain('news.ycombinator.com')).toBe('news.ycombinator.com');
  });

  it('rejects garbage', () => {
    expect(normalizeBlockDomain('')).toBeNull();
    expect(normalizeBlockDomain('   ')).toBeNull();
    expect(normalizeBlockDomain('not a domain')).toBeNull();
    expect(normalizeBlockDomain('localhost')).toBeNull(); // single label
    expect(normalizeBlockDomain('http://')).toBeNull();
  });
});

describe('isBlockedHost', () => {
  const domains = ['netflix.com', 'mail.google.com'];

  it('matches exact hosts and subdomains', () => {
    expect(isBlockedHost('netflix.com', domains)).toBe(true);
    expect(isBlockedHost('www.netflix.com', domains)).toBe(true);
    expect(isBlockedHost('help.netflix.com', domains)).toBe(true);
    expect(isBlockedHost('mail.google.com', domains)).toBe(true);
  });

  it('does not match lookalike or parent domains', () => {
    expect(isBlockedHost('notnetflix.com', domains)).toBe(false);
    expect(isBlockedHost('google.com', domains)).toBe(false); // only mail. is blocked
    expect(isBlockedHost('docs.google.com', domains)).toBe(false);
  });
});

describe('buildFocusRules', () => {
  const rules = buildFocusRules(['netflix.com', 'hulu.com'], 'chrome-extension://abc/blocked.html');

  it('assigns sequential ids from the base', () => {
    expect(rules.map((r) => r.id)).toEqual([FOCUS_DNR_ID_BASE, FOCUS_DNR_ID_BASE + 1]);
  });

  it('blocks main_frame requests for the domain (subdomains via requestDomains)', () => {
    expect(rules[0].condition.requestDomains).toEqual(['netflix.com']);
    expect(rules[0].condition.resourceTypes).toEqual(['main_frame']);
    expect(rules[0].condition.regexFilter).toBe('^https?://.*');
  });

  it('redirects with the original URL carried in the hash', () => {
    expect(rules[1].action.type).toBe('redirect');
    expect(rules[1].action.redirect?.regexSubstitution).toBe(
      'chrome-extension://abc/blocked.html#\\0',
    );
  });
});

describe('nextPhase', () => {
  const MIN = 60_000;
  const round1: FocusSession = { startedAt: 0, phase: 'focus', phaseStartedAt: 0, phaseEndsAt: 50 * MIN, focusMinutes: 50, round: 1 };

  it('ends a focus round in a break of the given length, same round', () => {
    const now = 50 * MIN + 400;
    expect(nextPhase(round1, 10, now)).toEqual({ ...round1, phase: 'break', phaseStartedAt: now, phaseEndsAt: now + 10 * MIN });
  });

  it('carries the clock-in intention through every phase', () => {
    const shift = { ...round1, intention: 'finish lit review' };
    const brk = nextPhase(shift, 10, 50 * MIN);
    expect(nextPhase(brk, 10, 60 * MIN).intention).toBe('finish lit review');
  });

  it('ends a break in the next focus round', () => {
    const now = 61 * MIN;
    const next = nextPhase(nextPhase(round1, 10, 50 * MIN), 10, now);
    expect(next).toEqual({ ...round1, round: 2, phaseStartedAt: now, phaseEndsAt: now + 50 * MIN });
  });

  it('times from now, so a late alarm never schedules a phase in the past', () => {
    const late = 3 * 60 * MIN;
    expect(nextPhase(round1, 10, late).phaseEndsAt).toBeGreaterThan(late);
  });
});
