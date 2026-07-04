import { describe, expect, it } from 'vitest';
import { FOCUS_DNR_ID_BASE } from './constants';
import { buildFocusRules, isBlockedHost, normalizeBlockDomain } from './focusRules';

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
