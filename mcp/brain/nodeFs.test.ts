import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexSkips, serverMayWrite } from './guards';
import { GuardError, nodeFs, type VaultFs } from './nodeFs';

let root = '';
let outside = '';
let fs: VaultFs;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'brain-fs-'));
  outside = await mkdtemp(join(tmpdir(), 'brain-out-'));
  fs = nodeFs(root, (rel) => serverMayWrite(rel));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('serverMayWrite', () => {
  it("allows notes and the server's own .brain folders, and nothing else", () => {
    for (const ok of ['Inbox/a.md', '.brain/staging/x/a.md', '.brain/journal/p.json', '.brain/history/2026-10-14/a.md', '.brain/trash/2026-10-14/a.md', '.brain/import/bookmarks.json', '.brain/mcp-log.jsonl', '.brain/starred.json']) {
      expect(serverMayWrite(ok), ok).toBe(true);
    }
    for (const no of ['sources/notion/a.md', 'Sources/a.md', '.brain/reports/x.md', '.BRAIN/Reports/x.md', '.brain/types.json', '.obsidian/app.json']) {
      expect(serverMayWrite(no), no).toBe(false);
    }
    expect(serverMayWrite('sources/notion/a.md', true)).toBe(true);
  });
  it('skips hidden folders, sources and attachments when indexing', () => {
    expect(['.brain', 'a/.trash', 'sources/notion', 'attachments'].every(indexSkips)).toBe(true);
    expect(indexSkips('School/DL Class')).toBe(false);
  });
});

describe('nodeFs', () => {
  it('writes atomically and leaves no temporary file', async () => {
    await fs.writeText('Inbox/a.md', 'hello');
    expect(await fs.readText('Inbox/a.md')).toBe('hello');
    expect(await readdir(join(root, 'Inbox'))).toEqual(['a.md']);
  });
  it('refuses paths that leave the vault', async () => {
    for (const bad of ['../x.md', '/etc/passwd', 'a\\b.md', 'a/./b.md', 'a\0b']) await expect(fs.writeText(bad, 'x')).rejects.toBeInstanceOf(GuardError);
    await symlink(outside, join(root, 'link'));
    await expect(fs.writeText('link/x.md', 'x')).rejects.toBeInstanceOf(GuardError);
    await expect(fs.readText('link/x.md')).rejects.toBeInstanceOf(GuardError);
  });
  it('refuses guarded writes, case-insensitively', async () => {
    await expect(fs.writeText('Sources/notion/a.md', 'x')).rejects.toThrow(/not allowed/);
    await expect(fs.remove('.brain/reports/x.md')).rejects.toThrow(/not allowed/);
  });
  it('copies bytes exactly and reads missing files as null', async () => {
    const bytes = new Uint8Array([0, 255, 10, 13, 128]);
    await fs.writeBytes('attachments/x.bin', bytes);
    await fs.copy('attachments/x.bin', 'Inbox/y.bin');
    expect(await fs.readBytes('Inbox/y.bin')).toEqual(bytes);
    expect(await fs.readText('nope.md')).toBeNull();
    expect(await fs.stat('nope.md')).toBeNull();
  });
  it('throws on text that is not UTF-8', async () => {
    await writeFile(join(root, 'bad.md'), new Uint8Array([0xc3, 0x28]));
    await expect(fs.readText('bad.md')).rejects.toThrow();
  });
  it('walks files, skipping junk, symlinks and skipped folders, keeping names as the disk has them', async () => {
    await mkdir(join(root, 'Concepts'), { recursive: true });
    await writeFile(join(root, 'Concepts', 'Café.md'), '# Café');
    await writeFile(join(root, '.DS_Store'), '');
    await mkdir(join(root, '.brain'), { recursive: true });
    await writeFile(join(root, '.brain', 'x.md'), '');
    await symlink(outside, join(root, 'link'));
    expect((await fs.walk('', indexSkips)).map((f) => f.path)).toEqual(['Concepts/Café.md']);
  });
  it('sweeps temporary files a crash left behind', async () => {
    await mkdir(join(root, 'Inbox'), { recursive: true });
    await writeFile(join(root, 'Inbox', '.a.md.brain-tmp-0b3f5c1e-2f4a-4d7e-9a51-6c1d2e3f4a5b'), 'half');
    expect(await fs.sweepTmp()).toBe(1);
    expect(await readdir(join(root, 'Inbox'))).toEqual([]);
  });
});
