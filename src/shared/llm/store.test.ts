import { describe, expect, it } from 'vitest';
import type { AiStats, Paper, ReadingProgress } from '../types';
import { hashText, probePercent, settleProbes } from './store';

const progress = (maxPercent: number, completedAt: number | null = null) =>
  ({ maxPercent, completedAt }) as ReadingProgress;
const lookup = (entries: Record<string, ReadingProgress>) => probePercent(entries, []);

const stats = (probes: AiStats['probes']): AiStats => ({ counts: {}, latencies: [], probes });

describe('settleProbes', () => {
  const now = 10_000_000;

  it('scores an advance at once, in the arm it belongs to', () => {
    const out = settleProbes(
      stats([{ key: 'a', startPercent: 40, recap: true, at: now - 1000 }]),
      lookup({ a: progress(56) }),
      now,
    );
    expect(out.probes).toEqual([]);
    expect(out.counts).toEqual({ 'resume.withRecap': 1, 'resume.withRecap.advanced': 1 });
  });

  it('counts finishing as advancing, whatever the percent', () => {
    const out = settleProbes(
      stats([{ key: 'a', startPercent: 95, recap: false, at: now }]),
      lookup({ a: progress(96, now) }),
      now,
    );
    expect(out.counts['resume.withoutRecap.advanced']).toBe(1);
  });

  it('waits out the window before calling a miss', () => {
    const probe = { key: 'a', startPercent: 40, recap: true, at: now - 60_000 };
    expect(settleProbes(stats([probe]), lookup({ a: progress(45) }), now).probes).toEqual([probe]);
    const late = settleProbes(stats([probe]), lookup({ a: progress(45) }), now + 31 * 60_000);
    expect(late.probes).toEqual([]);
    expect(late.counts).toEqual({ 'resume.withRecap': 1 });
  });

  it('scores a probe whose item was pruned as a miss once the window passes', () => {
    const out = settleProbes(
      stats([{ key: 'gone', startPercent: 10, recap: false, at: 0 }]),
      lookup({}),
      now,
    );
    expect(out.counts).toEqual({ 'resume.withoutRecap': 1 });
  });
});

describe('probePercent', () => {
  it('reads papers by id and treats a read paper as finished', () => {
    const papers = [
      { id: 'p1', status: 'reading', progressPercent: 40 },
      { id: 'p2', status: 'read', progressPercent: 70 },
    ] as Paper[];
    const percentOf = probePercent({}, papers);
    expect(percentOf('paper:p1')).toBe(40);
    expect(percentOf('paper:p2')).toBe(100);
    expect(percentOf('paper:gone')).toBeNull();
  });
});

describe('hashText', () => {
  it('is stable and distinguishes near-identical text', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
  });
});
