import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SearchDoc } from './lib/search';
import { workerSearch } from './regexSearch';

let dir = '';
const url = (name: string) => pathToFileURL(join(dir, name));
const on = (body: string) => `import { parentPort } from 'node:worker_threads'; parentPort.on('message', (m) => { ${body} });`;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'brain-worker-'));
  await writeFile(join(dir, 'done.mjs'), on("parentPort.postMessage({ id: m.id, hits: [{ path: 'b.md', title: 'B', score: 1 }, { path: 'a.md', title: 'A', score: 3 }] }); parentPort.postMessage({ id: m.id, done: true });"));
  await writeFile(join(dir, 'hang.mjs'), on("parentPort.postMessage({ id: m.id, hits: [{ path: 'a.md', title: 'A', score: 1 }] }); for (;;) {}"));
  // Answers with what it was sent: put paths as the title, the number dropped as the score.
  await writeFile(join(dir, 'echo.mjs'), on("parentPort.postMessage({ id: m.id, hits: [{ path: 'x', title: m.put.map((d) => d.path).join(','), score: m.drop.length }] }); if (m.query === 'hang') for (;;) {} parentPort.postMessage({ id: m.id, done: true });"));
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

const doc = (path: string): SearchDoc => ({ path, title: path, body: '', tags: [], headings: [], blocks: [], tasks: [] });

describe('workerSearch', () => {
  it('returns the ranked hits a worker finds', async () => {
    const r = await workerSearch(url('done.mjs'))('/x/', [], 10);
    expect(r).toEqual({ hits: [{ path: 'a.md', title: 'A', score: 3 }, { path: 'b.md', title: 'B', score: 1 }], partial: false });
  });
  it('stops a runaway worker and keeps what it found', async () => {
    const t0 = Date.now();
    const r = await workerSearch(url('hang.mjs'), 300)('/x/', [], 10);
    expect(r).toEqual({ hits: [{ path: 'a.md', title: 'A', score: 1 }], partial: true });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
  it('sends only changed docs to the worker it keeps, and everything to a new one', async () => {
    const run = workerSearch(url('echo.mjs'), 1_000);
    const sent = async (query: string, docs: SearchDoc[]) => (await run(query, docs, 1)).hits[0];
    const [a, b] = [doc('a.md'), doc('b.md')];
    expect(await sent('q', [a, b])).toMatchObject({ title: 'a.md,b.md', score: 0 });
    expect(await sent('q', [a, b])).toMatchObject({ title: '', score: 0 });
    const b2 = doc('b.md');
    expect(await sent('q', [a, b2])).toMatchObject({ title: 'b.md', score: 0 });
    expect(await sent('q', [a])).toMatchObject({ title: '', score: 1 });
    expect((await run('hang', [a], 1)).partial).toBe(true);
    expect(await sent('q', [a])).toMatchObject({ title: 'a.md', score: 0 });
  });
  it('runs overlapping searches one after the other', async () => {
    const run = workerSearch(url('done.mjs'));
    const [x, y] = await Promise.all([run('/x/', [], 1), run('/y/', [], 1)]);
    expect([x.hits, y.hits]).toEqual([[{ path: 'a.md', title: 'A', score: 3 }], [{ path: 'a.md', title: 'A', score: 3 }]]);
  });
});
