import { afterEach, describe, expect, it } from 'vitest';
import { testServer } from './testServer';

const FILES = {
  'Home.md': '---\ntags: [moc]\n---\n# Home\n\n- [[Sigmoid]]\n- [[Missing]]\n',
  'Concepts/Sigmoid.md': '---\naliases: [Logistic function]\n---\n# Sigmoid\n\nThe logistic curve.\n',
  'School/Lecture 3.md': '---\nsources: ["[[Sigmoid]]"]\n---\n# Lecture 3\n\nCovers [[Logistic function]] today.\n',
};
let t: Awaited<ReturnType<typeof testServer>>;
afterEach(async () => t?.close());

describe('read tools', () => {
  it('declares every read tool read-only', async () => {
    t = await testServer(FILES);
    const tools = (await t.client.listTools()).tools;
    for (const name of ['search', 'read_note', 'backlinks', 'list_moc', 'list_folder']) {
      expect(tools.find((x) => x.name === name)?.annotations).toMatchObject({ readOnlyHint: true });
    }
  });
  it('searches with Obsidian syntax and points at a malformed query', async () => {
    t = await testServer(FILES);
    // Both match in the body only, so they tie and sort by title.
    expect((await t.call('search', { query: 'logistic' })).text).toBe('Lecture 3 (School/Lecture 3.md)\nSigmoid (Concepts/Sigmoid.md)');
    expect((await t.call('search', { query: 'path:School' })).text).toBe('Lecture 3 (School/Lecture 3.md)');
    expect((await t.call('search', { query: 'nothing-here' })).text).toBe('No matches.');
    expect(await t.call('search', { query: '(logistic' })).toEqual({ text: 'unclosed parenthesis at character 1', error: true });
  });
  it('reads a note by title, alias or path, with its path', async () => {
    t = await testServer(FILES);
    for (const title of ['Sigmoid', 'logistic function', 'Concepts/Sigmoid.md']) {
      expect((await t.call('read_note', { title })).text).toBe(`path: Concepts/Sigmoid.md\n\n${FILES['Concepts/Sigmoid.md']}`);
    }
    expect(await t.call('read_note', { title: 'Nope' })).toEqual({ text: 'No note titled "Nope".', error: true });
  });
  it('lists backlinks with the line or property they come from', async () => {
    t = await testServer(FILES);
    expect((await t.call('backlinks', { title: 'Sigmoid' })).text.split('\n').sort()).toEqual([
      'Home (Home.md): - [[Sigmoid]]',
      'Lecture 3 (School/Lecture 3.md): Covers [[Logistic function]] today.',
      'Lecture 3 (School/Lecture 3.md): property "sources"',
    ]);
  });
  it("lists MOCs, a MOC's links in order, and folders", async () => {
    t = await testServer(FILES);
    expect((await t.call('list_moc', {})).text).toBe('Home (Home.md)');
    expect((await t.call('list_moc', { title: 'Home' })).text).toBe('- Sigmoid (Concepts/Sigmoid.md)\n- Missing (no such note yet)');
    expect((await t.call('list_folder', {})).text).toBe('Concepts/\nSchool/\nHome (Home.md)');
    expect((await t.call('list_folder', { folder: 'School' })).text).toBe('Lecture 3 (School/Lecture 3.md)');
  });
});
