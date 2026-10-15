import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workerSearch } from './regexSearch';

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'brain-worker-'));
  await writeFile(join(dir, 'done.mjs'), "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ hits: [{ path: 'b.md', title: 'B', score: 1 }, { path: 'a.md', title: 'A', score: 3 }] }); parentPort.postMessage({ done: true });");
  await writeFile(join(dir, 'hang.mjs'), "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ hits: [{ path: 'a.md', title: 'A', score: 1 }] }); for (;;) {}");
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

describe('workerSearch', () => {
  it('returns the ranked hits a worker finds', async () => {
    const r = await workerSearch(pathToFileURL(join(dir, 'done.mjs')))('/x/', [], 10);
    expect(r).toEqual({ hits: [{ path: 'a.md', title: 'A', score: 3 }, { path: 'b.md', title: 'B', score: 1 }], partial: false });
  });
  it('stops a runaway worker and keeps what it found', async () => {
    const t0 = Date.now();
    const r = await workerSearch(pathToFileURL(join(dir, 'hang.mjs')), 300)('/x/', [], 10);
    expect(r).toEqual({ hits: [{ path: 'a.md', title: 'A', score: 1 }], partial: true });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
