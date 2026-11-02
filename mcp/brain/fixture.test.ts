import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseQuery } from './lib/query';
import { search, toSearchDoc } from './lib/search';
import { Vault } from './vault';

let vault: Vault;
beforeAll(async () => {
  vault = await Vault.open(fileURLToPath(new URL('./fixtures/vault', import.meta.url)), { maintain: false });
});

describe('regression: the fixture vault', () => {
  it('indexes all fifteen notes', () => {
    expect(vault.entries.size).toBe(15);
  });
  it('gives the checked-in search results', () => {
    const docs = [...vault.entries.values()].map(toSearchDoc);
    const find = (q: string) => search(parseQuery(q), docs).hits.map((h) => h.title);
    expect(find('sigmoid')).toEqual(['Sigmoid', 'AI & ML', 'DL Class – Lecture 3', 'Gradient descent', 'Inbox note', 'Notes on \u{1D465} and \u{1D53C}']);
    expect(find('task-todo:derive')).toEqual(['Gradient descent']);
    expect(find('tag:moc')).toEqual(['AI & ML', 'DL Class', 'Home']);
    expect(find('line:(Windows Café)')).toEqual(['Windows note']);
  });
});
