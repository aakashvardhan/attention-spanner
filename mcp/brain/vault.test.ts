import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeVault } from './testServer';
import { StaleError, Vault } from './vault';

let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const now = () => new Date(2026, 9, 14, 9, 30);

describe('Vault', () => {
  it('indexes notes and skips hidden folders, sources, attachments and non-UTF-8 files', async () => {
    root = await writeVault({
      'Concepts/Sigmoid.md': '---\naliases: [Logistic function]\n---\n# Sigmoid\n',
      'Concepts/Café.md': '# Café\n',
      '.brain/x.md': '',
      'sources/notion/Page (1).md': '',
      '.obsidian/workspace.md': '',
      'attachments/sigmoid.png': new Uint8Array([1, 2]),
      'bad.md': new Uint8Array([0xc3, 0x28]),
    });
    const v = await Vault.open(root, { now });
    expect([...v.entries.keys()].sort()).toEqual(['Concepts/Café.md', 'Concepts/Sigmoid.md']);
    expect(v.find('logistic function')?.path).toBe('Concepts/Sigmoid.md');
    expect(v.find('Café')?.path).toBe('Concepts/Café.md');
    expect(v.find('Concepts/Sigmoid.md')?.title).toBe('Sigmoid');
    expect(v.targets().files.get('sigmoid.png')).toBe('attachments/sigmoid.png');
  });
  it('picks up changes made outside, and deletions', async () => {
    root = await writeVault({ 'a.md': '# A\n', 'b.md': '# B\n[[A]]\n' });
    const v = await Vault.open(root, { now });
    expect(v.backlinksOf('a.md').map((x) => x.from)).toEqual(['b.md']);
    await writeFile(join(root, 'b.md'), '# B\n');
    await utimes(join(root, 'b.md'), new Date(), new Date(Date.now() + 5_000));
    await rm(join(root, 'a.md'));
    await v.refresh();
    expect([...v.entries.keys()]).toEqual(['b.md']);
    expect(v.entries.get('b.md')!.links).toEqual([]);
  });
  it('never lets an older refresh, finishing last, drop a file a newer one found', async () => {
    root = await writeVault(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`n${i}.md`, `# ${i}\n`])));
    const v = await Vault.open(root, { now });
    // Changed files make the first refresh slow; the new file sorts first, so the second finds it early.
    for (let i = 0; i < 100; i++) await writeFile(join(root, `n${i}.md`), `# ${i} changed\n`);
    const first = v.refresh();
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(root, '0 new.md'), '# new\n');
    await Promise.all([first, v.refresh()]);
    expect(v.entries.has('0 new.md')).toBe(true);
  });
  it('refuses an edit before a read, and after the file changed on disk', async () => {
    root = await writeVault({ 'a.md': '# A\n' });
    const v = await Vault.open(root, { now });
    expect(() => v.assertFresh('a.md')).toThrow(StaleError);
    v.markRead('a.md');
    expect(() => v.assertFresh('a.md')).not.toThrow();
    await writeFile(join(root, 'a.md'), '# A changed\n');
    await utimes(join(root, 'a.md'), new Date(), new Date(Date.now() + 5_000));
    await v.refresh();
    expect(() => v.assertFresh('a.md')).toThrow(/changed since read/);
  });
  it('snapshots into history before a plan changes a file, and sweeps old history', async () => {
    root = await writeVault({ 'a.md': 'old\n', '.brain/history/2026-10-01/090000000/a.md': 'ancient\n' });
    const v = await Vault.open(root, { now });
    await v.execute({ id: 'p', label: 'l', steps: [{ op: 'write', path: 'a.md', text: 'new\n' }] });
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('new\n');
    const days = await v.fs.listDirs('.brain/history');
    expect(days).toEqual(['2026-10-14']);
    const [stamp] = await v.fs.listDirs('.brain/history/2026-10-14');
    expect(await v.fs.readText(`.brain/history/2026-10-14/${stamp}/a.md`)).toBe('old\n');
  });
  it('on open, sweeps temporary files and finishes interrupted plans', async () => {
    root = await writeVault({
      '.a.md.brain-tmp-0b3f5c1e-2f4a-4d7e-9a51-6c1d2e3f4a5b': 'half',
      '.brain/journal/p.json': JSON.stringify({ plan: { id: 'p', label: 'l', steps: [{ op: 'write', path: 'done.md', text: 'x' }] }, done: 0 }),
    });
    const v = await Vault.open(root, { now });
    expect(v.entries.has('done.md')).toBe(true);
    expect(await v.fs.list('')).toEqual(['done.md']);
  });
  it('finishes an interrupted promote on open, even though it writes sources/', async () => {
    const staged = '.brain/staging/pilot/sources/notion/P (1).md';
    root = await writeVault({
      [staged]: 'raw',
      '.brain/journal/p.json': JSON.stringify({ plan: { id: 'p', label: 'promote pilot', steps: [{ op: 'copy', from: staged, to: 'sources/notion/P (1).md' }, { op: 'remove', path: staged }] }, done: 0 }),
    });
    const v = await Vault.open(root, { now });
    expect(await v.fs.readText('sources/notion/P (1).md')).toBe('raw');
    expect(await v.fs.exists(staged)).toBe(false);
  });
  it('runs serial work in order, even after a failure', async () => {
    root = await writeVault({});
    const v = await Vault.open(root, { now });
    const order: number[] = [];
    await Promise.allSettled([
      v.serial(async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
        throw new Error('x');
      }),
      v.serial(async () => order.push(2)),
    ]);
    expect(order).toEqual([1, 2]);
  });
  it('logs each write and gives staged content one digest', async () => {
    root = await writeVault({ '.brain/staging/pilot/Concepts/A.md': '# A\n' });
    const v = await Vault.open(root, { now });
    await v.log('create_note', { path: 'x.md' });
    expect(JSON.parse((await v.fs.readText('.brain/mcp-log.jsonl'))!.trim())).toMatchObject({ tool: 'create_note', path: 'x.md' });
    const d1 = await v.stagingDigest('pilot');
    await mkdir(join(root, '.brain/staging/pilot/Concepts'), { recursive: true });
    await writeFile(join(root, '.brain/staging/pilot/Concepts/A.md'), '# A changed\n');
    expect(await v.stagingDigest('pilot')).not.toBe(d1);
  });
});
