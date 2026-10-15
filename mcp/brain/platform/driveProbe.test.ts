import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ping, pong, stats } from './driveProbe';

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('ping and pong', () => {
  it('measure every round trip through a shared folder', async () => {
    dir = await mkdtemp(join(tmpdir(), 'brain-probe-'));
    const [rtts, answered] = await Promise.all([
      ping(dir, { rounds: 3, gapMs: 5, timeoutMs: 2_000, pollMs: 5 }),
      pong(dir, { pollMs: 5, maxMs: 5_000 }),
    ]);
    expect(answered).toBe(3);
    expect(rtts).toHaveLength(3);
    expect(rtts.every(Number.isFinite)).toBe(true);
  });
  it('answers a run whose first ping was written before pong started', async () => {
    dir = await mkdtemp(join(tmpdir(), 'brain-probe-'));
    const pinging = ping(dir, { rounds: 2, gapMs: 5, timeoutMs: 2_000, pollMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    const [rtts, answered] = await Promise.all([pinging, pong(dir, { pollMs: 5, maxMs: 3_000 })]);
    expect(answered).toBe(2);
    expect(rtts.every(Number.isFinite)).toBe(true);
  });
  it('ignores a ping left over from an earlier run', async () => {
    dir = await mkdtemp(join(tmpdir(), 'brain-probe-'));
    await writeFile(join(dir, 'ping.json'), JSON.stringify({ run: 'old', seq: 30, done: true }));
    const answered = pong(dir, { pollMs: 5, maxMs: 300 });
    expect(await answered).toBe(0);
  });
});

describe('stats', () => {
  it('counts lost rounds and takes the median of the rest', () => {
    expect(stats([300, Number.NaN, 100, 200])).toEqual({ rounds: 4, lost: 1, medianRttMs: 200, maxRttMs: 300 });
    expect(stats([])).toEqual({ rounds: 0, lost: 0, medianRttMs: null, maxRttMs: null });
  });
});
