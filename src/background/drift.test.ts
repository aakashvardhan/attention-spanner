import { describe, expect, it } from 'vitest';
import type { FocusSession, Paper } from '../shared/types';
import { driftCandidate, focusTarget, isDistraction } from './drift';

const session: FocusSession = { startedAt: 1000, phaseEndsAt: 9000, focusMinutes: 50 };
const ddpm = { id: 'p', title: 'DDPM', url: 'https://arxiv.org/abs/2006.11239', status: 'reading', lastReadAt: 5 } as Paper;
const base = { session, checked: { startedAt: 0, hosts: [] }, blocklist: ['youtube.com'], target: ddpm };

describe('driftCandidate', () => {
  it('asks about an unknown host once per session', () => {
    expect(driftCandidate({ ...base, url: 'https://www.reddit.com/r/nba' })).toBe('reddit.com');
    const checked = { startedAt: 1000, hosts: ['reddit.com'] };
    expect(driftCandidate({ ...base, checked, url: 'https://reddit.com/r/other' })).toBeNull();
  });

  it('asks again in a new session', () => {
    const checked = { startedAt: 500, hosts: ['reddit.com'] };
    expect(driftCandidate({ ...base, checked, url: 'https://reddit.com/' })).toBe('reddit.com');
  });

  it('leaves the paper itself, blocked hosts and non-web pages alone', () => {
    expect(driftCandidate({ ...base, url: 'https://arxiv.org/pdf/2006.11239v2' })).toBeNull();
    expect(driftCandidate({ ...base, url: 'https://m.youtube.com/watch?v=x' })).toBeNull();
    expect(driftCandidate({ ...base, url: 'chrome-extension://abc/newtab.html' })).toBeNull();
  });

  it('does nothing without a paper to be focused on', () => {
    expect(driftCandidate({ ...base, target: null, url: 'https://reddit.com/' })).toBeNull();
  });
});

describe('focusTarget', () => {
  it('is the reading paper touched last', () => {
    const older = { ...ddpm, id: 'old', lastReadAt: 1 };
    const done = { ...ddpm, id: 'done', status: 'read', lastReadAt: 99 } as Paper;
    expect(focusTarget([older, ddpm, done])?.id).toBe('p');
    expect(focusTarget([done])).toBeNull();
  });
});

describe('isDistraction', () => {
  // Measured: a low P(on-task) also covers PyTorch docs (0.04) and the author's
  // Scholar page (0.03), so only a confident P(distraction) may nudge.
  it('nudges only when Laya is sure the page is a distraction', () => {
    expect(isDistraction({ type: 'noul', noul: 0.93 })).toBe(true); // r/nba
    expect(isDistraction({ type: 'noul', noul: 0.39 })).toBe(false); // PyTorch docs
    expect(isDistraction({ type: 'noul', noul: 0.03 })).toBe(false); // a related arXiv paper
    expect(isDistraction(undefined)).toBe(false);
  });
});
