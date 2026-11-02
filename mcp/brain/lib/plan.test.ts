import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { recover, runPlan, type Plan, type Step } from './plan';
import { Crash, FC, MemFs } from './testing';

const NAMES = ['a.md', 'b.md', 'c.md', 'd.md'];

/** A start state and a plan that is valid on it: every copy has a source when it runs. */
const scenario = fc
  .record({
    start: fc.uniqueArray(fc.constantFrom(...NAMES), { minLength: 1 }),
    ops: fc.array(fc.tuple(fc.constantFrom('write', 'copy', 'remove'), fc.nat(3), fc.nat(3), fc.string({ maxLength: 4 })), { maxLength: 6 }),
  })
  .map(({ start, ops }) => {
    const exists = new Set(start);
    const steps: Step[] = [];
    for (const [op, i, j, text] of ops) {
      const [p, q] = [NAMES[i], NAMES[j]];
      if (op === 'write') {
        steps.push({ op, path: p, text });
        exists.add(p);
      } else if (op === 'copy' && exists.has(p) && p !== q) {
        steps.push({ op, from: p, to: q });
        exists.add(q);
      } else if (op === 'remove') {
        steps.push({ op, path: p });
        exists.delete(p);
      }
    }
    const plan: Plan = { id: 'p1', label: 'test', steps };
    return { start: Object.fromEntries(start.map((s) => [s, `start ${s}`])), plan };
  });

async function endState(start: Record<string, string>, plan: Plan) {
  const fs = new MemFs(start);
  await runPlan(fs, plan);
  return fs.all();
}

/** Mutating calls an uninterrupted run makes: one journal write, then a step and a journal update per step, then the journal removal. */
const calls = (plan: Plan) => 2 + 2 * plan.steps.length;

describe('runPlan and recover', () => {
  it('leaves the start state or the end state after a crash at any step', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ start, plan }) => {
        const end = await endState(start, plan);
        const initial = new MemFs(start).all();
        for (let k = 0; k <= calls(plan); k++) {
          const fs = new MemFs(start);
          fs.writesLeft = k;
          await runPlan(fs, plan).catch((e) => {
            if (!(e instanceof Crash)) throw e;
          });
          fs.writesLeft = Infinity;
          await recover(fs);
          expect(fs.all()).toEqual(k === 0 ? initial : end);
        }
      }),
      { ...FC, numRuns: 100 },
    );
  });
  it('survives a second crash during recovery', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, fc.nat(20), fc.nat(20), async ({ start, plan }, k1, k2) => {
        const fs = new MemFs(start);
        fs.writesLeft = 1 + (k1 % calls(plan));
        await runPlan(fs, plan).catch(() => undefined);
        fs.writesLeft = k2;
        await recover(fs).catch(() => undefined);
        fs.writesLeft = Infinity;
        await recover(fs);
        expect(fs.all()).toEqual(await endState(start, plan));
      }),
      { ...FC, numRuns: 100 },
    );
  });
  it('deletes the journal when a plan finishes', async () => {
    const fs = new MemFs({ 'a.md': 'x' });
    await runPlan(fs, { id: 'p', label: 'l', steps: [{ op: 'copy', from: 'a.md', to: 'b.md' }, { op: 'remove', path: 'a.md' }] });
    expect(await fs.list('.brain/journal')).toEqual([]);
    expect(fs.all()).toEqual([['b.md', 'x']]);
  });
});
