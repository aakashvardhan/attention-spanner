/**
 * Plans, not I/O (spec, Architecture). A rename, move, delete or promote is a
 * list of steps; each host runs it through its own PlanFs. The journal makes a
 * plan finish after a crash: recovery rolls forward from the step that was
 * running, and every step is safe to run twice.
 */

export type Step = { op: 'write'; path: string; text: string } | { op: 'copy'; from: string; to: string } | { op: 'remove'; path: string };
export interface Plan { id: string; label: string; steps: Step[] }

export interface PlanFs {
  readText(path: string): Promise<string | null>;
  /** Atomic per file: after a crash, the old content or the new, never a mix. */
  writeText(path: string, text: string): Promise<void>;
  /** Atomic per file; creates folders. */
  copy(from: string, to: string): Promise<void>;
  /** No error when the file is already gone. */
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** File paths directly inside `dir`; [] when it does not exist. */
  list(dir: string): Promise<string[]>;
}

export const JOURNAL = '.brain/journal';
interface JournalEntry { plan: Plan; done: number }

export const newPlanId = (): string => `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

async function apply(fs: PlanFs, s: Step): Promise<void> {
  if (s.op === 'write') return fs.writeText(s.path, s.text);
  if (s.op === 'remove') return fs.remove(s.path);
  if (await fs.exists(s.from)) return fs.copy(s.from, s.to);
  // The copy ran, then a later step removed its source, before the crash.
  if (!(await fs.exists(s.to))) throw new Error(`cannot finish "${s.from}" -> "${s.to}": both are missing`);
}

async function finish(fs: PlanFs, rec: JournalEntry): Promise<void> {
  const path = `${JOURNAL}/${rec.plan.id}.json`;
  for (let i = rec.done; i < rec.plan.steps.length; i++) {
    await apply(fs, rec.plan.steps[i]);
    await fs.writeText(path, JSON.stringify({ plan: rec.plan, done: i + 1 }));
  }
  await fs.remove(path);
}

export async function runPlan(fs: PlanFs, plan: Plan): Promise<void> {
  await fs.writeText(`${JOURNAL}/${plan.id}.json`, JSON.stringify({ plan, done: 0 }));
  await finish(fs, { plan, done: 0 });
}

/** Finishes every plan a crash interrupted. Hosts call it on start, before anything else touches the vault. */
export async function recover(fs: PlanFs): Promise<string[]> {
  const finished: string[] = [];
  for (const path of await fs.list(JOURNAL)) {
    if (!path.endsWith('.json')) continue;
    let rec: JournalEntry | null = null;
    try {
      rec = JSON.parse((await fs.readText(path)) ?? 'null') as JournalEntry | null;
    } catch {
      rec = null;
    }
    // Journal writes are atomic, so an unreadable file was not written by us; leave it for a person.
    if (!rec?.plan?.steps) continue;
    await finish(fs, rec);
    finished.push(rec.plan.label);
  }
  return finished;
}
