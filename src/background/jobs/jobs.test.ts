import { describe, expect, it } from 'vitest';
import type { Job, JobProfile, JobStatus } from '../../shared/types';
import { profileHash, scoreJob } from '../../shared/jobs/score';
import { mergeJobs, pruneJobs, rescore } from './index';
import { workdayPrefilter } from './sources';

const NOW = Date.UTC(2026, 7, 12);
const DAY = 24 * 60 * 60 * 1000;

function profile(patch: Partial<JobProfile> = {}): JobProfile {
  return {
    skills: ['python'],
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

function job(id: string, patch: Partial<Job> = {}): Job {
  return {
    id,
    source: 'ycombinator',
    company: 'Acme',
    title: 'Machine Learning Engineer',
    locations: ['Remote'],
    remote: true,
    url: `https://x.test/${id}`,
    applyUrl: `https://x.test/${id}`,
    postedAt: NOW - DAY,
    description: 'Python.',
    kind: 'new-grad',
    status: 'new',
    requirements: null,
    score: null,
    capturedAt: NOW - DAY,
    ...patch,
  };
}

describe('mergeJobs', () => {
  it('accumulates the union across two rotating pulls', () => {
    // YC returns a different 37 each time; coverage has to build up.
    const first = [job('a'), job('b')];
    const second = [job('b'), job('c')];
    expect(mergeJobs(first, second, NOW).map((j) => j.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('keeps your status when the source re-sends the posting', () => {
    const mine = [job('a', { status: 'applied', capturedAt: 1234 })];
    const [merged] = mergeJobs(mine, [job('a', { status: 'new', title: 'Retitled' })], NOW);
    expect(merged.status).toBe('applied');
    expect(merged.capturedAt).toBe(1234);
    // Everything the source owns is still refreshed.
    expect(merged.title).toBe('Retitled');
  });

  it('does not duplicate a posting that is fetched twice in one run', () => {
    expect(mergeJobs([], [job('a'), job('a')], NOW)).toHaveLength(1);
  });
});

describe('pruneJobs', () => {
  it('never drops a job you shortlisted or applied to', () => {
    // Those are your records now, not the source's.
    const ancient = { capturedAt: NOW - 400 * DAY, postedAt: NOW - 400 * DAY };
    const jobs: Job[] = [
      job('applied', { status: 'applied' as JobStatus, ...ancient }),
      job('short', { status: 'shortlist' as JobStatus, ...ancient }),
      job('stale', { status: 'new' as JobStatus, ...ancient }),
    ];
    expect(pruneJobs(jobs, NOW).map((j) => j.id).sort()).toEqual(['applied', 'short']);
  });

  it('keeps a fresh untouched posting', () => {
    expect(pruneJobs([job('fresh')], NOW).map((j) => j.id)).toEqual(['fresh']);
  });

  it('respects the cap, keeping the better-ranked jobs', () => {
    const scored = (id: string, total: number) =>
      job(id, { score: { total, parts: [], blockers: [], computedAt: NOW, profileHash: 'h' } });
    const kept = pruneJobs([scored('low', 10), scored('high', 90), scored('mid', 50)], NOW, 2);
    expect(kept.map((j) => j.id)).toEqual(['high', 'mid']);
  });

  it('lets applied jobs exceed the cap rather than evicting them', () => {
    const jobs = [
      job('a', { status: 'applied' }),
      job('b', { status: 'applied' }),
      job('c', { status: 'new' }),
    ];
    const kept = pruneJobs(jobs, NOW, 1);
    expect(kept.map((j) => j.id).sort()).toEqual(['a', 'b']);
  });
});

describe('rescore', () => {
  it('rescores only what the current profile has not scored', () => {
    const current = profile();
    const alreadyScored = job('a', { score: scoreJob(job('a'), current, NOW) });
    const stale = job('b', { score: scoreJob(job('b'), profile({ usCitizen: true }), NOW) });

    const [keptA, redoneB] = rescore([alreadyScored, stale], current, NOW + 5000);
    expect(keptA.score?.computedAt).toBe(NOW);
    expect(redoneB.score?.computedAt).toBe(NOW + 5000);
    expect(redoneB.score?.profileHash).toBe(profileHash(current));
  });
});

describe('workdayPrefilter', () => {
  const listing = (title: string) => ({ title, externalPath: `/job/${title}`, locationsText: 'US' });

  it('cuts a 907-posting tenant down before anything is fetched', () => {
    // The whole defence against Workday's N+1. Budgets alone would just spend
    // themselves on the first 25 rows in whatever order the server chose.
    const listings = Array.from({ length: 907 }, (_, i) => listing(`Senior Engineer ${i}`));
    expect(workdayPrefilter(listings, profile())).toEqual([]);
  });

  it('keeps the roles the profile actually wants', () => {
    const listings = [
      listing('Software Engineering Intern, Summer 2027'),
      listing('PhD Research Scientist'),
      listing('Senior Staff Engineer'),
      listing('Director of Engineering'),
      listing('Machine Learning Engineer'),
      listing('Warehouse Associate'),
    ];
    expect(workdayPrefilter(listings, profile()).map((l) => l.title)).toEqual([
      'Software Engineering Intern, Summer 2027',
      'PhD Research Scientist',
      'Machine Learning Engineer',
    ]);
  });

  it('drops a stage the profile filtered out', () => {
    const listings = [listing('Software Engineering Intern')];
    expect(workdayPrefilter(listings, profile({ kinds: ['new-grad'] }))).toEqual([]);
  });

  it('honours the detail limit', () => {
    const listings = Array.from({ length: 80 }, (_, i) => listing(`Research Intern ${i}`));
    expect(workdayPrefilter(listings, profile(), 25)).toHaveLength(25);
  });
});
