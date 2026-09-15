import { describe, expect, it } from 'vitest';
import type { Job, JobProfile, JobRequirements } from '../types';
import { compareJobs, hasTerm, needsRescore, profileHash, scoreJob } from './score';

const NOW = Date.UTC(2026, 7, 12);
const DAY = 24 * 60 * 60 * 1000;

function profile(patch: Partial<JobProfile> = {}): JobProfile {
  return {
    skills: ['python', 'pytorch'],
    roleFamilies: ['machine learning'],
    kinds: ['new-grad', 'internship', 'research'],
    locations: [],
    maxYearsRequired: 3,
    needsSponsorship: false,
    usCitizen: false,
    watchlist: [],
    ...patch,
  };
}

function requirements(patch: Partial<JobRequirements> = {}): JobRequirements {
  return { skills: [], minYears: null, sponsors: null, requiresCitizenship: false, mustHaves: [], ...patch };
}

function job(patch: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    source: 'ycombinator',
    company: 'Acme',
    title: 'Machine Learning Engineer, New Grad',
    locations: ['San Francisco'],
    remote: null,
    url: 'https://x.test/1',
    applyUrl: 'https://x.test/1/apply',
    postedAt: NOW - 2 * DAY,
    description: 'You will use Python and PyTorch.',
    kind: 'new-grad',
    status: 'new',
    requirements: requirements(),
    score: null,
    capturedAt: NOW,
    ...patch,
  };
}

describe('hasTerm', () => {
  it('matches whole terms only', () => {
    expect(hasTerm('We write Go and Rust', 'go')).toBe(true);
    // The false hit a plain includes() would produce.
    expect(hasTerm('This is a category page', 'go')).toBe(false);
    // The false hit fuzzyScore's subsequence tier would produce.
    expect(hasTerm('specialist queue logic', 'sql')).toBe(false);
  });

  it('survives punctuation around the term', () => {
    expect(hasTerm('Experience with C++, Python.', 'c++')).toBe(true);
    expect(hasTerm('node.js and react', 'node.js')).toBe(true);
  });
});

describe('scoreJob blockers', () => {
  it('blocks on an experience bar above the ceiling', () => {
    const score = scoreJob(job({ requirements: requirements({ minYears: 6 }) }), profile(), NOW);
    expect(score.blockers).toEqual(['Wants 6+ years']);
  });

  it('does not block when the bar is within reach', () => {
    const score = scoreJob(job({ requirements: requirements({ minYears: 2 }) }), profile(), NOW);
    expect(score.blockers).toEqual([]);
  });

  it('reads an unstated requirement as permission, not refusal', () => {
    // Every field null — the common case for Greenhouse, which ships prose only.
    const score = scoreJob(job({ requirements: null }), profile({ needsSponsorship: true }), NOW);
    expect(score.blockers).toEqual([]);
  });

  it('blocks on sponsorship only when the profile needs it', () => {
    const noSponsor = job({ requirements: requirements({ sponsors: false }) });
    expect(scoreJob(noSponsor, profile({ needsSponsorship: false }), NOW).blockers).toEqual([]);
    expect(scoreJob(noSponsor, profile({ needsSponsorship: true }), NOW).blockers).toEqual([
      'Will not sponsor',
    ]);
  });

  it('blocks on citizenship only when the profile lacks it', () => {
    const cleared = job({ requirements: requirements({ requiresCitizenship: true }) });
    expect(scoreJob(cleared, profile({ usCitizen: true }), NOW).blockers).toEqual([]);
    expect(scoreJob(cleared, profile({ usCitizen: false }), NOW).blockers).toEqual([
      'Requires US citizenship or clearance',
    ]);
  });

  it('lets a remote posting through a location filter', () => {
    const remote = job({ locations: ['Berlin'], remote: true });
    expect(scoreJob(remote, profile({ locations: ['San Francisco'] }), NOW).blockers).toEqual([]);
  });

  it('blocks an on-site posting outside the wanted cities', () => {
    const berlin = job({ locations: ['Berlin'], remote: false });
    expect(scoreJob(berlin, profile({ locations: ['San Francisco'] }), NOW).blockers).toEqual([
      'Not in San Francisco',
    ]);
  });

  it('still scores a blocked job rather than zeroing it', () => {
    // Sinking, not hiding: a misjudged regex must cost a glance, not a job.
    const score = scoreJob(job({ requirements: requirements({ minYears: 9 }) }), profile(), NOW);
    expect(score.blockers).toHaveLength(1);
    expect(score.total).toBeGreaterThan(0);
  });
});

describe('scoreJob parts', () => {
  it('sums to total and never exceeds 100', () => {
    const score = scoreJob(job(), profile({ watchlist: ['Acme'] }), NOW);
    expect(score.total).toBe(score.parts.reduce((sum, p) => sum + p.points, 0));
    expect(score.parts.reduce((sum, p) => sum + p.max, 0)).toBe(100);
    expect(score.total).toBeLessThanOrEqual(100);
  });

  it('credits skills in proportion to how many appear', () => {
    const half = scoreJob(job({ description: 'You will use Python.' }), profile(), NOW);
    expect(half.parts.find((p) => p.label === 'Skills')?.points).toBe(18);
  });

  it('scores a title role match above a body-only mention', () => {
    const inTitle = scoreJob(job(), profile(), NOW);
    const inBody = scoreJob(
      job({ title: 'Engineer', description: 'Our machine learning team is growing.' }),
      profile(),
      NOW,
    );
    const points = (s: ReturnType<typeof scoreJob>) => s.parts.find((p) => p.label === 'Role')?.points;
    expect(points(inTitle)).toBe(25);
    expect(points(inBody)).toBe(12);
  });

  it('scores an unknown posting date mid, not zero', () => {
    // YC and Workday both withhold it; zeroing would bury two whole sources.
    const unknown = scoreJob(job({ postedAt: null }), profile(), NOW);
    const stale = scoreJob(job({ postedAt: NOW - 200 * DAY }), profile(), NOW);
    const fresh = scoreJob(job({ postedAt: NOW - 1 * DAY }), profile(), NOW);
    const points = (s: ReturnType<typeof scoreJob>) => s.parts.find((p) => p.label === 'Fresh')?.points;
    expect(points(stale)).toBe(0);
    expect(points(unknown)).toBe(5);
    expect(points(fresh)).toBe(10);
  });

  it('explains every part, including the ones that scored nothing', () => {
    for (const part of scoreJob(job(), profile(), NOW).parts) {
      expect(part.why).not.toBe('');
    }
  });
});

describe('profileHash / needsRescore', () => {
  it('is stable under key order and list order', () => {
    expect(profileHash(profile({ skills: ['python', 'pytorch'] }))).toBe(
      profileHash(profile({ skills: ['pytorch', 'python'] })),
    );
  });

  it('changes when a filter that affects scoring changes', () => {
    expect(profileHash(profile())).not.toBe(profileHash(profile({ maxYearsRequired: 8 })));
  });

  it('forces a rescore when the profile moved', () => {
    const scored = job({ score: scoreJob(job(), profile(), NOW) });
    expect(needsRescore(scored, profileHash(profile()))).toBe(false);
    expect(needsRescore(scored, profileHash(profile({ usCitizen: true })))).toBe(true);
    expect(needsRescore(job({ score: null }), profileHash(profile()))).toBe(true);
  });
});

describe('compareJobs', () => {
  it('sinks blocked jobs below every clear one, whatever they scored', () => {
    const strongButBlocked = job({
      id: 'blocked',
      score: scoreJob(job({ requirements: requirements({ minYears: 9 }) }), profile({ watchlist: ['Acme'] }), NOW),
    });
    const weakButClear = job({
      id: 'clear',
      score: scoreJob(job({ title: 'Engineer', description: '' }), profile(), NOW),
    });
    expect([strongButBlocked, weakButClear].sort(compareJobs).map((j) => j.id)).toEqual([
      'clear',
      'blocked',
    ]);
  });
});
