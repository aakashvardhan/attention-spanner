import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCapped } from './tools/import';
import { testServer } from './testServer';

let t: Awaited<ReturnType<typeof testServer>>;
afterEach(async () => t?.close());
const fakeFetch = (async (url: string) =>
  url.endsWith('/expired') ? new Response('gone', { status: 403 }) : new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 })) as unknown as typeof fetch;
const audit = async (area: string, pass = true) =>
  writeFile(join(t.root, '.brain', 'reports', `${area}-audit.json`), JSON.stringify({ pass, digest: await t.vault.stagingDigest(area) }));

describe('import tools', () => {
  it('stages notes, sources and attachments where the import expects them', async () => {
    t = await testServer({ '.brain/reports/.keep': '' }, { fetch: fakeFetch });
    expect((await t.call('stage_note', { area: 'pilot', path: 'Concepts/Sigmoid.md', text: '# Sigmoid\n' })).text).toBe('Staged Concepts/Sigmoid.md for pilot.');
    expect((await t.call('stage_note', { area: 'pilot', path: 'sources/notion/Lecture 3 (abc).md', text: 'raw' })).error).toBe(false);
    expect((await t.call('stage_attachment', { area: 'pilot', url: 'https://file.notion.so/x.png', filename: 'sigmoid.png' })).text).toMatch(/^Staged attachments\/sigmoid\.png \(4 bytes, sha256 [0-9a-f]{64}\)\.$/);
    expect(await t.call('stage_attachment', { area: 'pilot', url: 'https://file.notion.so/expired', filename: 'a.png' })).toEqual({
      text: 'Download failed with HTTP 403; fetch a fresh signed URL from Notion and retry.',
      error: true,
    });
  });
  it('refuses unsafe areas, paths and URLs', async () => {
    t = await testServer({}, { fetch: fakeFetch });
    expect((await t.call('stage_note', { area: '../x', path: 'a.md', text: '' })).error).toBe(true);
    for (const path of ['.brain/x.md', '.obsidian/a.md', '.git/a.md', 'Concepts/.trash/a.md', 'attachments/a.md', 'a.txt', 'A/B: c.md']) expect((await t.call('stage_note', { area: 'pilot', path, text: '' })).error, path).toBe(true);
    expect((await t.call('stage_attachment', { area: 'pilot', url: 'http://file.notion.so/x.png', filename: 'x.png' })).text).toBe('Only https URLs are fetched.');
  });
  it('refuses folder, source and attachment names Windows cannot hold', async () => {
    t = await testServer({}, { fetch: fakeFetch });
    for (const path of ['Career: 2026/A.md', 'sources/notion/Q: A (abc).md']) expect((await t.call('stage_note', { area: 'pilot', path, text: '' })).error, path).toBe(true);
    expect(await t.call('stage_attachment', { area: 'pilot', url: 'https://file.notion.so/x.png', filename: 'Shot 10:30.png' })).toEqual({
      text: '"Shot 10:30.png" cannot be a file name on Windows; use "Shot 10-30.png".',
      error: true,
    });
  });
  it('promotes only what a passing audit covered, then empties staging', async () => {
    t = await testServer({ '.brain/reports/.keep': '', 'Concepts/Sigmoid.md': '# Old sigmoid\n' }, { fetch: fakeFetch });
    await t.call('stage_note', { area: 'pilot', path: 'Concepts/Sigmoid.md', text: '# Sigmoid, merged\n' });
    await t.call('stage_note', { area: 'pilot', path: 'sources/notion/Lecture 3 (abc).md', text: 'raw' });
    await t.call('stage_attachment', { area: 'pilot', url: 'https://file.notion.so/x.png', filename: 'sigmoid.png' });
    expect((await t.call('promote_staging', { area: 'pilot' })).text).toMatch(/no passing fidelity audit/);
    await audit('pilot', false);
    expect((await t.call('promote_staging', { area: 'pilot' })).error).toBe(true);
    await audit('pilot');
    await t.call('stage_note', { area: 'pilot', path: 'Concepts/Late.md', text: 'added after the audit' });
    expect((await t.call('promote_staging', { area: 'pilot' })).text).toMatch(/no passing fidelity audit/);
    await audit('pilot');
    expect((await t.call('promote_staging', { area: 'pilot' })).text).toBe('Promoted 4 files from pilot.');
    expect(await readFile(join(t.root, 'Concepts/Sigmoid.md'), 'utf8')).toBe('# Sigmoid, merged\n');
    expect(await readFile(join(t.root, 'sources/notion/Lecture 3 (abc).md'), 'utf8')).toBe('raw');
    expect([...(await readFile(join(t.root, 'attachments/sigmoid.png')))]).toEqual([137, 80, 78, 71]);
    expect(await t.vault.fs.walk('.brain/staging/pilot')).toEqual([]);
    const [stamp] = await t.vault.fs.listDirs('.brain/history/2026-10-14');
    expect(await t.vault.fs.readText(`.brain/history/2026-10-14/${stamp}/Concepts/Sigmoid.md`)).toBe('# Old sigmoid\n');
  });
  it('refuses a staged title another note owns, and an attachment with different bytes', async () => {
    t = await testServer({ '.brain/reports/.keep': '', 'Inbox/Sigmoid.md': '# Sigmoid\n', 'attachments/a.png': 'other' }, { fetch: fakeFetch });
    await t.call('stage_note', { area: 'pilot', path: 'Concepts/Sigmoid.md', text: '# Sigmoid\n' });
    await audit('pilot');
    expect((await t.call('promote_staging', { area: 'pilot' })).text).toBe('"Sigmoid" is already used by Inbox/Sigmoid.md');
    await t.close();
    t = await testServer({ '.brain/reports/.keep': '', 'attachments/a.png': 'other' }, { fetch: fakeFetch });
    await t.call('stage_attachment', { area: 'pilot', url: 'https://file.notion.so/x.png', filename: 'a.png' });
    await audit('pilot');
    expect((await t.call('promote_staging', { area: 'pilot' })).text).toBe('attachments/a.png already exists with different content; stage it under another name.');
  });
  it('never removes a stage that lands while the same path is being promoted', async () => {
    t = await testServer({ '.brain/reports/.keep': '' }, { fetch: fakeFetch });
    await t.call('stage_note', { area: 'pilot', path: 'Concepts/A.md', text: 'v1' });
    await audit('pilot');
    // Stage v2 just before promote removes the staged copy of A.md, and give it time to land.
    const fs = t.vault.fs;
    const remove = fs.remove.bind(fs);
    let staging: Promise<unknown> | null = null;
    fs.remove = async (rel) => {
      if (!staging && rel.endsWith('Concepts/A.md')) {
        staging = t.call('stage_note', { area: 'pilot', path: 'Concepts/A.md', text: 'v2' });
        await new Promise((r) => setTimeout(r, 100));
      }
      return remove(rel);
    };
    expect((await t.call('promote_staging', { area: 'pilot' })).text).toBe('Promoted 1 files from pilot.');
    await staging;
    const where = [await t.vault.fs.readText('.brain/staging/pilot/Concepts/A.md'), await t.vault.fs.readText('Concepts/A.md')];
    expect(where).toContain('v2');
  });
  it('refuses an attachment over 100 MB by its Content-Length, before reading it', async () => {
    let read = false;
    // highWaterMark 0: pull runs only when someone reads.
    const body = new ReadableStream({ pull: () => void (read = true) }, { highWaterMark: 0 });
    const big = (async () => new Response(body, { status: 200, headers: { 'content-length': String(200 * 1024 * 1024) } })) as unknown as typeof fetch;
    t = await testServer({}, { fetch: big });
    expect(await t.call('stage_attachment', { area: 'pilot', url: 'https://file.notion.so/x.png', filename: 'x.png' })).toEqual({ text: 'x.png is 209715200 bytes or more, over the 100 MB limit.', error: true });
    expect(read).toBe(false);
    expect(await t.vault.fs.walk('.brain/staging')).toEqual([]);
  });
});

describe('readCapped', () => {
  const stream = (chunks: number, size: number) => {
    let n = 0;
    const chunk = new Uint8Array(size).fill(7);
    return new ReadableStream<Uint8Array>({ pull: (c) => (n++ < chunks ? c.enqueue(chunk) : c.close()) });
  };
  it('stops reading as soon as a body without Content-Length passes the limit', async () => {
    let pulled = 0;
    const s = stream(1_000, 10);
    const counted = s.pipeThrough(new TransformStream({ transform: (c, ctl) => void (pulled++, ctl.enqueue(c)) }));
    expect(await readCapped(new Response(counted), 25)).toBe(30);
    expect(pulled).toBeLessThan(10);
  });
  it('returns the whole body within the limit', async () => {
    expect(await readCapped(new Response(stream(3, 4)), 12)).toEqual(new Uint8Array(12).fill(7));
  });
});
