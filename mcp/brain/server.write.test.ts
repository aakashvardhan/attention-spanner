import { readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { FC } from './lib/testing';
import { testServer } from './testServer';

let t: Awaited<ReturnType<typeof testServer>>;
afterEach(async () => t?.close());
const read = (rel: string) => readFile(join(t.root, rel), 'utf8');

describe('write tools', () => {
  it('marks destructive tools as destructive', async () => {
    t = await testServer({});
    const tools = (await t.client.listTools()).tools;
    for (const name of ['write_note', 'rename_note', 'move_note', 'delete_note']) expect(tools.find((x) => x.name === name)?.annotations?.destructiveHint, name).toBe(true);
    expect(tools.find((x) => x.name === 'daily_note')?.annotations?.idempotentHint).toBe(true);
  });
  it("creates today's daily note once, holding only its heading", async () => {
    t = await testServer({});
    expect((await t.call('daily_note')).text).toBe('path: daily/2026-10-14.md\n\n# Wednesday, 14 October 2026\n');
    expect((await t.call('daily_note')).text).toBe('path: daily/2026-10-14.md\n\n# Wednesday, 14 October 2026\n');
  });
  it('refuses a date that does not exist instead of creating a junk daily note', async () => {
    t = await testServer({});
    expect(await t.call('daily_note', { date: '2026-13-45' })).toEqual({ text: '"2026-13-45" is not a date.', error: true });
    expect(await t.call('daily_note', { date: '2026-02-30' })).toEqual({ text: '"2026-02-30" is not a date.', error: true });
    expect(await t.vault.fs.list('daily')).toEqual([]);
  });
  it('creates notes in Inbox, moves an unsafe title into aliases, and refuses a clash', async () => {
    t = await testServer({ 'Concepts/Sigmoid.md': '# Sigmoid\n' });
    expect((await t.call('create_note', { title: 'Idea', text: '# Idea\n' })).text).toBe('Created Inbox/Idea.md.');
    expect((await t.call('create_note', { title: 'A/B test', text: '# A/B\n' })).text).toContain('Created Inbox/A-B test.md');
    expect(await read('Inbox/A-B test.md')).toBe('---\naliases: [A/B test]\n---\n# A/B\n');
    expect(await t.call('create_note', { title: 'sigmoid', text: '' })).toEqual({ text: '"sigmoid" is already used by Concepts/Sigmoid.md', error: true });
    expect(await t.call('create_note', { title: 'X', text: '', folder: 'a//b' })).toEqual({ text: '"a//b" is not a folder notes can live in.', error: true });
  });
  it('edits only after a read, refuses a stale or ambiguous edit, and keeps history', async () => {
    t = await testServer({ 'a.md': '# A\none\ntwo\ntwo\n' });
    expect(await t.call('edit_note', { title: 'a', old_str: 'one', new_str: '1' })).toEqual({ text: 'read "a" first', error: true });
    await t.call('read_note', { title: 'a' });
    expect((await t.call('edit_note', { title: 'a', old_str: 'two', new_str: '2' })).text).toBe('old_str occurs 2 times; include more context or set replace_all');
    expect((await t.call('edit_note', { title: 'a', old_str: 'one', new_str: '$1 one' })).text).toBe('Edited a.md.');
    expect(await read('a.md')).toBe('# A\n$1 one\ntwo\ntwo\n');
    await writeFile(join(t.root, 'a.md'), '# A changed in the Brain page\n');
    await utimes(join(t.root, 'a.md'), new Date(), new Date(Date.now() + 5_000));
    expect(await t.call('edit_note', { title: 'a', old_str: 'A', new_str: 'B' })).toEqual({ text: 'changed since read, re-read first', error: true });
    const [stamp] = await t.vault.fs.listDirs('.brain/history/2026-10-14');
    expect(await t.vault.fs.readText(`.brain/history/2026-10-14/${stamp}/a.md`)).toBe('# A\none\ntwo\ntwo\n');
  });
  it('renames with links rewritten, moves, and deletes into trash', async () => {
    t = await testServer({ 'Concepts/Sigmoid.md': '# Sigmoid\n', 'School/L3.md': '---\nsources: ["[[Sigmoid]]"]\n---\nSee [[Sigmoid]].\n' });
    expect((await t.call('rename_note', { title: 'Sigmoid', new_title: 'Logistic sigmoid' })).text).toBe('Renamed "Sigmoid" to "Logistic sigmoid"; updated links in 1 note.');
    expect(await read('School/L3.md')).toBe('---\nsources: ["[[Logistic sigmoid]]"]\n---\nSee [[Logistic sigmoid]].\n');
    expect((await t.call('move_note', { title: 'Logistic sigmoid', folder: 'Inbox' })).text).toBe('Moved "Logistic sigmoid" to Inbox.');
    expect((await t.call('delete_note', { title: 'L3' })).text).toBe('Moved "L3" to .brain/trash/2026-10-14/. Restore it from there within 30 days.');
    expect([...t.vault.entries.keys()]).toEqual(['Inbox/Logistic sigmoid.md']);
    const log = (await read('.brain/mcp-log.jsonl')).trim().split('\n').map((l) => JSON.parse(l).tool);
    expect(log).toEqual(['rename_note', 'move_note', 'delete_note']);
  });
  it('never loses the note when a rename races an edit of it', async () => {
    t = await testServer({ 'a.md': '# A\nEND\n' });
    await t.call('read_note', { title: 'a' });
    const [ren, ed] = await Promise.all([t.call('rename_note', { title: 'a', new_title: 'b' }), t.call('edit_note', { title: 'a', old_str: 'END', new_str: 'token\nEND' })]);
    expect(ren.error).toBe(false);
    expect([...t.vault.entries.keys()]).toEqual(['b.md']);
    const text = await read('b.md');
    if (ed.error) expect(ed.text).toBe('No note titled "a".');
    else expect(text).toBe('# A\ntoken\nEND\n');
  });
});

describe('model: parallel calls never lose an edit', () => {
  it('keeps every successful edit exactly once, in the vault or its trash', async () => {
    const TITLES = ['N0', 'N1', 'N2', 'N3'];
    const op = fc.tuple(fc.constantFrom('edit', 'rename', 'create', 'delete'), fc.nat(3), fc.nat(3));
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 10 }), async (ops) => {
        t = await testServer({ 'Inbox/N0.md': '# N0\nEND\n', 'Inbox/N1.md': '# N1\nEND\n' });
        try {
          const kept: string[] = [];
          await Promise.all(
            ops.map(async ([kind, a, b], i) => {
              if (kind === 'edit') {
                await t.call('read_note', { title: TITLES[a] });
                const r = await t.call('edit_note', { title: TITLES[a], old_str: 'END', new_str: `token-${i}\nEND` });
                if (!r.error) kept.push(`token-${i}`);
                else expect(r.text).toMatch(/No note titled|changed since read|read ".*" first/);
              } else if (kind === 'rename') await t.call('rename_note', { title: TITLES[a], new_title: TITLES[b] });
              else if (kind === 'create') await t.call('create_note', { title: TITLES[a], text: `# ${TITLES[a]}\nEND\n` });
              else await t.call('delete_note', { title: TITLES[a] });
            }),
          );
          const files = (await t.vault.fs.walk('', (d) => /^\.brain\/(history|journal|staging)/.test(d))).filter((f) => f.path.endsWith('.md'));
          const texts = await Promise.all(files.map((f) => t.vault.fs.readText(f.path)));
          for (const tok of kept) expect(texts.join('\n').split(tok + '\n').length - 1, tok).toBe(1);
          expect(t.vault.duplicates()).toEqual([]);
          expect(await t.vault.fs.list('.brain/journal')).toEqual([]);
        } finally {
          await t.close();
        }
      }),
      { ...FC, numRuns: 30 },
    );
  });
});
