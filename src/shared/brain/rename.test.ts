import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildEntry, targetsOf } from './entry';
import { resolve } from './links';
import { nfc, titleKey } from './names';
import { runPlan } from './plan';
import { planDelete, planHeadingRename, planMove, planRename, STARRED, type NoteText, type Planned } from './rename';
import { FC, MemFs } from './testing';

const SIG: NoteText = { path: 'Concepts/Sigmoid.md', text: '---\naliases: [Logistic function]\n---\n# Sigmoid\n\nSelf [[Sigmoid#Uses]].\n\n## Uses\n' };
const LEC: NoteText = { path: 'School/Lecture 3.md', text: "---\nsources: ['[[Sigmoid]]']\n---\n# Lecture 3\r\n\r\n[[Sigmoid]] [[sigmoid|s]] ![[Sigmoid#Uses]] [[Logistic function]] `[[Sigmoid]]`\r\n" };
const titles = new Map([
  [titleKey('Sigmoid'), SIG.path],
  [titleKey('Logistic function'), SIG.path],
  [titleKey('Lecture 3'), LEC.path],
]);

async function apply(files: NoteText[], p: Planned) {
  if (!p.ok) throw new Error(p.error);
  const fs = new MemFs(Object.fromEntries(files.map((f) => [f.path, f.text])));
  await runPlan(fs, p.plan);
  return fs;
}

describe('planRename', () => {
  it('moves the file and rewrites body, embed and property links, keeping CRLF, aliases and code', async () => {
    const p = planRename({ note: SIG, newTitle: 'Logistic sigmoid', linkers: [LEC], titles, starred: '["Sigmoid","Other"]' });
    const fs = await apply([SIG, LEC, { path: STARRED, text: '["Sigmoid","Other"]' }], p);
    expect(fs.all().map(([n]) => n)).toEqual([STARRED, 'Concepts/Logistic sigmoid.md', LEC.path]);
    expect(await fs.readText(LEC.path)).toBe(
      '---\nsources: ["[[Logistic sigmoid]]"]\n---\n# Lecture 3\r\n\r\n[[Logistic sigmoid]] [[Logistic sigmoid|s]] ![[Logistic sigmoid#Uses]] [[Logistic function]] `[[Sigmoid]]`\r\n',
    );
    expect(await fs.readText('Concepts/Logistic sigmoid.md')).toContain('Self [[Logistic sigmoid#Uses]]');
    expect(await fs.readText(STARRED)).toBe('["Logistic sigmoid","Other"]');
    expect(p.ok && p.rewritten).toEqual([LEC.path]);
  });
  it('renames through a temporary name when only the case changes', async () => {
    const fs = await apply([SIG, LEC], planRename({ note: SIG, newTitle: 'SIGMOID', linkers: [LEC], titles, starred: null }));
    expect(fs.all().map(([n]) => n)).toEqual(['Concepts/SIGMOID.md', LEC.path]);
  });
  it('refuses a title or alias already in use, an unsafe title and no change', () => {
    expect(planRename({ note: LEC, newTitle: 'logistic FUNCTION', linkers: [], titles, starred: null })).toEqual({ ok: false, error: '"logistic FUNCTION" is already used by Concepts/Sigmoid.md' });
    expect(planRename({ note: SIG, newTitle: 'A/B', linkers: [], titles, starred: null })).toMatchObject({ ok: false, error: expect.stringContaining('try "A-B"') });
    expect(planRename({ note: SIG, newTitle: 'Sigmoid', linkers: [], titles, starred: null })).toMatchObject({ ok: false });
  });
});

describe('planMove and planDelete', () => {
  it('copies then removes, leaving links alone', async () => {
    const fs = await apply([SIG], planMove({ note: SIG, folder: 'Inbox', paths: new Set([titleKey(SIG.path)]) }));
    expect(fs.all()).toEqual([['Inbox/Sigmoid.md', SIG.text]]);
  });
  it('refuses a clash, the same folder and folders the vault reserves', () => {
    expect(planMove({ note: SIG, folder: 'Inbox', paths: new Set([titleKey('inbox/sigmoid.md')]) })).toMatchObject({ ok: false });
    expect(planMove({ note: SIG, folder: 'Concepts', paths: new Set() })).toMatchObject({ ok: false });
    for (const f of ['.brain', 'sources/notion', 'attachments', '../up']) expect(planMove({ note: SIG, folder: f, paths: new Set() })).toMatchObject({ ok: false });
  });
  it("moves a deleted note into the day's trash, numbering a clash", async () => {
    const p = planDelete({ note: SIG, date: '2026-10-14', taken: new Set([titleKey('.brain/trash/2026-10-14/Sigmoid.md')]) });
    const fs = await apply([SIG], p);
    expect(fs.all()).toEqual([['.brain/trash/2026-10-14/Sigmoid 2.md', SIG.text]]);
  });
});

describe('planHeadingRename', () => {
  it('rewrites links to that heading in other notes and in the note itself, and nothing else', async () => {
    const other: NoteText = { path: 'Other.md', text: '[[Sigmoid#uses]] [[Sigmoid#Definition]] [[Lecture 3#Uses]]\n' };
    const self = { ...SIG, text: SIG.text.replace('## Uses', '## Applications').replace('[[Sigmoid#Uses]]', '[[Sigmoid#Uses]] [[#Uses]]') };
    const fs = await apply([self, other], planHeadingRename({ note: self, oldHeading: 'Uses', newHeading: 'Applications', linkers: [other] }));
    expect(await fs.readText('Other.md')).toBe('[[Sigmoid#Applications]] [[Sigmoid#Definition]] [[Lecture 3#Uses]]\n');
    expect(await fs.readText(SIG.path)).toContain('[[Sigmoid#Applications]] [[#Applications]]');
  });
});

// Model-based proof (spec, Testing: Property). Notes have stable ids in the model; after any sequence of
// create, rename, move, delete and edit, every link resolves to the note the model says it should.
const TITLES = ['Sigmoid', 'sigmoid', 'Café', 'Café notes', 'DL Class – Lecture 3', 'Résumé', 'Notes (draft)', 'Graph theory', 'Lecture 3', 'Aa'];
const FOLDERS = ['', 'Concepts', 'School/DL Class', 'Inbox'];
interface MNote { title: string; folder: string; links: number[] }
interface Model { notes: Map<number, MNote>; dead: Map<number, string>; next: number }
const pathOf = (n: MNote) => `${n.folder ? n.folder + '/' : ''}${nfc(n.title)}.md`;
const aliveByTitle = (m: Model, title: string) => [...m.notes].find(([, n]) => titleKey(n.title) === titleKey(title))?.[0] ?? null;
const expected = (m: Model, id: number) => (m.notes.has(id) ? id : aliveByTitle(m, m.dead.get(id)!));
const alive = (m: Model) => [...m.notes.keys()];
const notesOf = (fs: MemFs) => fs.all().filter(([p]) => !p.startsWith('.brain/') && p.endsWith('.md'));

async function invariant(m: Model, fs: MemFs) {
  const entries = notesOf(fs).map(([p, t]) => buildEntry(p, t));
  const t = targetsOf(entries, []);
  const idAt = new Map([...m.notes].map(([id, n]) => [titleKey(pathOf(n)), id]));
  expect(entries).toHaveLength(m.notes.size);
  for (const [, n] of m.notes) {
    const e = entries.find((x) => titleKey(x.path) === titleKey(pathOf(n)));
    expect(e, `${pathOf(n)} exists`).toBeDefined();
    const got = e!.links.map((l) => {
      const p = resolve(l, e!.path, t);
      return p ? (idAt.get(titleKey(p)) ?? -1) : null;
    });
    expect(got.map(String).sort()).toEqual(n.links.map((id) => expected(m, id)).map(String).sort());
  }
}

const linkLine = (m: Model, id: number) => `[[${m.notes.get(id)!.title}]]`;
const textOf = (fsText: string | null) => fsText ?? '';
const all = (fs: MemFs): NoteText[] => notesOf(fs).map(([path, text]) => ({ path, text }));
const titleMap = (fs: MemFs) => targetsOf(notesOf(fs).map(([p, t]) => buildEntry(p, t)), []).notes;

class Create implements fc.AsyncCommand<Model, MemFs> {
  constructor(readonly ti: number, readonly fi: number, readonly picks: number[]) {}
  check = (m: Readonly<Model>) => aliveByTitle(m as Model, TITLES[this.ti]) === null;
  async run(m: Model, fs: MemFs) {
    const ids = alive(m);
    const links = ids.length ? this.picks.map((k) => ids[k % ids.length]) : [];
    const n: MNote = { title: nfc(TITLES[this.ti]), folder: FOLDERS[this.fi], links };
    await fs.writeText(pathOf(n), `# ${n.title}\n\n${links.map((id) => linkLine(m, id)).join('\n')}\n`);
    m.notes.set(m.next++, n);
    await invariant(m, fs);
  }
  toString = () => `create(${TITLES[this.ti]} in ${FOLDERS[this.fi]})`;
}
class Rename implements fc.AsyncCommand<Model, MemFs> {
  constructor(readonly pick: number, readonly ti: number) {}
  check = (m: Readonly<Model>) => m.notes.size > 0;
  async run(m: Model, fs: MemFs) {
    const id = alive(m)[this.pick % m.notes.size];
    const n = m.notes.get(id)!;
    const to = nfc(TITLES[this.ti]);
    const p = planRename({ note: { path: pathOf(n), text: textOf(await fs.readText(pathOf(n))) }, newTitle: to, linkers: all(fs), titles: titleMap(fs), starred: null });
    const clash = aliveByTitle(m, to);
    if ((clash !== null && clash !== id) || to === n.title) {
      expect(p.ok).toBe(false);
      return;
    }
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    await runPlan(fs, p.plan);
    // Links that resolved to this note by its old title (including revived dangling ones) now follow it.
    for (const other of m.notes.values()) other.links = other.links.map((x) => (expected(m, x) === id ? id : x));
    n.title = to;
    await invariant(m, fs);
  }
  toString = () => `rename(#${this.pick} -> ${TITLES[this.ti]})`;
}
class Move implements fc.AsyncCommand<Model, MemFs> {
  constructor(readonly pick: number, readonly fi: number) {}
  check = (m: Readonly<Model>) => m.notes.size > 0;
  async run(m: Model, fs: MemFs) {
    const n = m.notes.get(alive(m)[this.pick % m.notes.size])!;
    const p = planMove({ note: { path: pathOf(n), text: textOf(await fs.readText(pathOf(n))) }, folder: FOLDERS[this.fi], paths: new Set(notesOf(fs).map(([x]) => titleKey(x))) });
    if (FOLDERS[this.fi] === n.folder) {
      expect(p.ok).toBe(false);
      return;
    }
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    await runPlan(fs, p.plan);
    n.folder = FOLDERS[this.fi];
    await invariant(m, fs);
  }
  toString = () => `move(#${this.pick} -> ${FOLDERS[this.fi]})`;
}
class Delete implements fc.AsyncCommand<Model, MemFs> {
  constructor(readonly pick: number) {}
  check = (m: Readonly<Model>) => m.notes.size > 0;
  async run(m: Model, fs: MemFs) {
    const id = alive(m)[this.pick % m.notes.size];
    const n = m.notes.get(id)!;
    const taken = new Set((await fs.list('.brain/trash/2026-10-14')).map(titleKey));
    const p = planDelete({ note: { path: pathOf(n), text: textOf(await fs.readText(pathOf(n))) }, date: '2026-10-14', taken });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    await runPlan(fs, p.plan);
    m.dead.set(id, n.title);
    m.notes.delete(id);
    await invariant(m, fs);
  }
  toString = () => `delete(#${this.pick})`;
}
class Edit implements fc.AsyncCommand<Model, MemFs> {
  constructor(readonly pick: number, readonly target: number) {}
  check = (m: Readonly<Model>) => m.notes.size > 1;
  async run(m: Model, fs: MemFs) {
    const ids = alive(m);
    const id = ids[this.pick % ids.length];
    const to = ids[(this.pick + 1 + (this.target % (ids.length - 1))) % ids.length];
    const n = m.notes.get(id)!;
    await fs.writeText(pathOf(n), textOf(await fs.readText(pathOf(n))) + `${linkLine(m, to)}\n`);
    n.links.push(to);
    await invariant(m, fs);
  }
  toString = () => `edit(#${this.pick} links #${this.target})`;
}

describe('model: no rename, move or delete ever breaks a link it should keep', () => {
  it('holds for any sequence of operations', async () => {
    const cmds = [
      fc.tuple(fc.nat(TITLES.length - 1), fc.nat(FOLDERS.length - 1), fc.array(fc.nat(9), { maxLength: 3 })).map(([t, f, p]) => new Create(t, f, p)),
      fc.tuple(fc.nat(9), fc.nat(TITLES.length - 1)).map(([p, t]) => new Rename(p, t)),
      fc.tuple(fc.nat(9), fc.nat(FOLDERS.length - 1)).map(([p, f]) => new Move(p, f)),
      fc.nat(9).map((p) => new Delete(p)),
      fc.tuple(fc.nat(9), fc.nat(9)).map(([p, t]) => new Edit(p, t)),
    ];
    await fc.assert(
      fc.asyncProperty(fc.commands(cmds, { maxCommands: 25 }), (c) => fc.asyncModelRun(() => ({ model: { notes: new Map(), dead: new Map(), next: 0 }, real: new MemFs() }), c)),
      FC,
    );
  });
});
