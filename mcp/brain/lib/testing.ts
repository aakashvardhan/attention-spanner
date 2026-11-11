import { JOURNAL, type PlanFs } from './plan';

/** Property tests share one seed so CI is repeatable; fast-check prints it on failure. Override with FC_SEED. */
export const FC = { seed: Number(process.env.FC_SEED ?? 20261014), numRuns: 200 };

/**
 * A speed budget in a test. BRAIN_PERF=1 checks the real budget, on a quiet machine. Otherwise it is
 * five times looser: still enough to catch a quadratic slip, without failing on a loaded CI runner or
 * when vitest runs every file at once. Tests that check one pass PERF_TIMEOUT so the loose budget fits.
 */
export const budgetMs = (ms: number): number => (process.env.BRAIN_PERF === '1' ? ms : ms * 5);
export const PERF_TIMEOUT = 30_000;

export class Crash extends Error {}

const key = (p: string) => p.normalize('NFC').toLowerCase();

/**
 * In-memory PlanFs, case-insensitive like APFS and NTFS: writing "a.md" over an
 * existing "A.md" keeps the old name. `writesLeft` simulates a crash on the
 * next mutating call.
 */
export class MemFs implements PlanFs {
  private files = new Map<string, { name: string; text: string }>();
  writesLeft = Infinity;
  constructor(init: Record<string, string> = {}) {
    for (const [name, text] of Object.entries(init)) this.files.set(key(name), { name, text });
  }
  private tick() {
    if (this.writesLeft <= 0) throw new Crash('simulated crash');
    this.writesLeft--;
  }
  async readText(p: string) {
    return this.files.get(key(p))?.text ?? null;
  }
  async writeText(p: string, text: string) {
    this.tick();
    this.files.set(key(p), { name: this.files.get(key(p))?.name ?? p, text });
  }
  async copy(from: string, to: string) {
    this.tick();
    const src = this.files.get(key(from));
    if (!src) throw new Error(`no such file: ${from}`);
    this.files.set(key(to), { name: this.files.get(key(to))?.name ?? to, text: src.text });
  }
  async remove(p: string) {
    this.tick();
    this.files.delete(key(p));
  }
  async exists(p: string) {
    return this.files.has(key(p));
  }
  async list(dir: string) {
    const pre = key(dir.replace(/\/?$/, '/'));
    return [...this.files.entries()].filter(([k]) => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map(([, f]) => f.name).sort();
  }
  /** Every file with its stored name, journal excluded, sorted: the state a plan is judged by. */
  all(): [string, string][] {
    return [...this.files.values()]
      .filter((f) => !key(f.name).startsWith(JOURNAL + '/'))
      .map((f): [string, string] => [f.name, f.text])
      .sort(([a], [b]) => a.localeCompare(b));
  }
}
