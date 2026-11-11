import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { reportsDir, vaultPath } from '../args';

// A partly synced file reads as invalid JSON; treat it as not there yet.
const readJson = async (p: string): Promise<any> => {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
};

/** Mac side: write ping n, wait for pong n. A round trip needs no shared clock. */
export async function ping(dir: string, o: { rounds: number; gapMs: number; timeoutMs: number; pollMs?: number }): Promise<number[]> {
  const run = randomUUID();
  const rtts: number[] = [];
  for (let seq = 1; seq <= o.rounds; seq++) {
    const sent = Date.now();
    await writeFile(join(dir, 'ping.json'), JSON.stringify({ run, seq, done: seq === o.rounds }));
    for (;;) {
      await sleep(o.pollMs ?? 250);
      const p = await readJson(join(dir, 'pong.json'));
      if (p?.run === run && p.seq === seq) {
        rtts.push(Date.now() - sent);
        break;
      }
      if (Date.now() - sent > o.timeoutMs) {
        rtts.push(Number.NaN);
        break;
      }
    }
    if (seq < o.rounds) await sleep(o.gapMs);
  }
  return rtts;
}

/** Other machine: answer each new ping, except those of a run that had already finished when this one started. */
export async function pong(dir: string, o: { pollMs?: number; maxMs: number }): Promise<number> {
  // Only a finished run is stale: a run in progress may have written its first ping a moment before this started.
  const first = await readJson(join(dir, 'ping.json'));
  const stale = first?.done ? first.run : null;
  const start = Date.now();
  let run: string | null = null;
  let last = 0;
  let answered = 0;
  while (Date.now() - start < o.maxMs) {
    const p = await readJson(join(dir, 'ping.json'));
    if (p && p.run !== stale) {
      if (p.run !== run) {
        run = p.run;
        last = 0;
      }
      if (p.seq > last) {
        last = p.seq;
        answered++;
        await writeFile(join(dir, 'pong.json'), JSON.stringify({ run, seq: p.seq }));
        if (p.done) break;
      }
    }
    await sleep(o.pollMs ?? 250);
  }
  return answered;
}

export function stats(rtts: number[]): { rounds: number; lost: number; medianRttMs: number | null; maxRttMs: number | null } {
  const ok = rtts.filter(Number.isFinite).sort((a, b) => a - b);
  return { rounds: rtts.length, lost: rtts.length - ok.length, medianRttMs: ok.length ? ok[Math.floor(ok.length / 2)] : null, maxRttMs: ok.length ? ok[ok.length - 1] : null };
}

const KNOWN_MTIME = new Date('2001-02-03T04:05:06.000Z');
const ROLES = ['ping', 'pong', 'mtime-write', 'mtime-check', 'rename-write', 'rename-watch', 'conflict-setup', 'conflict-list', 'cold-seed', 'cold-measure'];

/** Each role is one measurement from spec Ground truth; results append to platform-<host>.json. */
export async function driveProbe(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { vault: { type: 'string' }, role: { type: 'string' }, rounds: { type: 'string' } } });
  const vault = vaultPath(values.vault);
  const dir = join(vault, '.brain', 'probe');
  await mkdir(dir, { recursive: true });
  const record = async (probe: string, result: unknown) => {
    const file = join(await reportsDir(vault), `platform-${hostname()}.json`);
    const all = ((await readJson(file)) ?? []) as unknown[];
    await writeFile(file, JSON.stringify([...all, { probe, at: new Date().toISOString(), result }], null, 1));
    console.log(probe, JSON.stringify(result));
  };
  switch (values.role) {
    case 'ping':
      return record('sync round trip', stats(await ping(dir, { rounds: Number(values.rounds ?? 30), gapMs: 10_000, timeoutMs: 300_000 })));
    case 'pong':
      return record('pongs answered', await pong(dir, { maxMs: 4 * 3_600_000 }));
    case 'mtime-write': {
      const f = join(dir, 'mtime.md');
      await writeFile(f, 'mtime probe\n');
      await utimes(f, KNOWN_MTIME, KNOWN_MTIME);
      return record('mtime written', { mtime: KNOWN_MTIME.toISOString() });
    }
    case 'mtime-check': {
      const s = await stat(join(dir, 'mtime.md'));
      return record('mtime after sync', { mtime: s.mtime.toISOString(), preserved: s.mtimeMs === KNOWN_MTIME.getTime() });
    }
    case 'rename-write': {
      const a = join(dir, 'rename-a.md');
      await writeFile(a, 'rename probe\n');
      await sleep(60_000);
      await rename(a, join(dir, 'rename-b.md'));
      return record('renamed a to b', { at: new Date().toISOString() });
    }
    case 'rename-watch': {
      const seen: { at: string; names: string[] }[] = [];
      let prev = '';
      for (const end = Date.now() + 600_000; Date.now() < end; await sleep(500)) {
        const names = (await readdir(dir)).filter((n) => n.startsWith('rename-')).sort();
        if (names.join() !== prev) {
          seen.push({ at: new Date().toISOString(), names });
          prev = names.join();
        }
        if (names.length === 1 && names[0] === 'rename-b.md') break;
      }
      return record('rename as seen here', seen);
    }
    case 'conflict-setup':
      await writeFile(join(dir, 'conflict.md'), 'base\n');
      return record('conflict base written', {});
    case 'conflict-list':
      return record('conflict files', (await readdir(dir)).filter((n) => /conflict/i.test(n)));
    case 'cold-seed':
      for (let i = 0; i < 20; i++) await writeFile(join(dir, `cold-${i}.md`), 'cold probe line\n'.repeat(3000));
      return record('cold files seeded', { files: 20 });
    case 'cold-measure': {
      const rows: { file: string; ms: number; result: string }[] = [];
      for (const file of (await readdir(dir)).filter((n) => n.startsWith('cold-'))) {
        const t0 = Date.now();
        const result = await Promise.race([
          readFile(join(dir, file)).then(() => 'ok', (e: NodeJS.ErrnoException) => e.code ?? 'error'),
          // Unref'd: the read keeps the process alive, a finished race's timer must not.
          sleep(30_000, undefined, { ref: false }).then(() => 'timeout'),
        ]);
        rows.push({ file, ms: Date.now() - t0, result });
      }
      return record('cold reads', rows);
    }
    default:
      throw new Error(`--role must be one of: ${ROLES.join(', ')}`);
  }
}
