import { describe, expect, it } from 'vitest';
import { parseNote } from './frontmatter';
import { propertyLinks, resolve, retarget, wikiLinks, type Targets } from './links';
import { titleKey } from './names';

describe('wikiLinks', () => {
  it('reads every link form', () => {
    const ls = wikiLinks('[[A]] [[B|b]] [[C#H]] [[D#H|d]] ![[e.png]] ![[F#H]] [[#Own]]');
    expect(ls.map((l) => [l.target, l.heading, l.alias, l.embed])).toEqual([
      ['A', null, null, false],
      ['B', null, 'b', false],
      ['C', 'H', null, false],
      ['D', 'H', 'd', false],
      ['e.png', null, null, true],
      ['F', 'H', null, true],
      ['', 'Own', null, false],
    ]);
  });
  it('skips links inside code and ignores empty [[]]', () => {
    const text = 'x `[[No]]` [[Yes]] [[]]';
    expect(wikiLinks(text, [[2, 10]]).map((l) => l.target)).toEqual(['Yes']);
  });
  it('reads links written as property values', () => {
    const n = parseNote('---\nsources: ["[[DL Class – Lecture 3]]", "notion:abc"]\nrelated: "[[Café]]"\n---\n');
    expect(propertyLinks(n.fields).map((l) => [l.property, l.target])).toEqual([
      ['sources', 'DL Class – Lecture 3'],
      ['related', 'Café'],
    ]);
  });
});

describe('resolve', () => {
  const t: Targets = {
    notes: new Map([
      [titleKey('Sigmoid'), 'Concepts/Sigmoid.md'],
      [titleKey('Logistic function'), 'Concepts/Sigmoid.md'],
      [titleKey('Café'), 'Concepts/Café.md'],
      [titleKey('Lecture 3.5'), 'School/Lecture 3.5.md'],
    ]),
    files: new Map([[titleKey('sigmoid.png'), 'attachments/sigmoid.png']]),
  };
  const link = (s: string) => wikiLinks(s)[0];
  it('finds notes by title or alias, ignoring case', () => {
    expect(resolve(link('[[sigmoid]]'), 'x.md', t)).toBe('Concepts/Sigmoid.md');
    expect(resolve(link('[[Logistic Function|f]]'), 'x.md', t)).toBe('Concepts/Sigmoid.md');
  });
  it('resolves an NFC link to a file macOS lists in NFD', () => {
    expect(resolve(link('[[Café]]'), 'x.md', t)).toBe('Concepts/Café.md');
  });
  it('accepts path and .md forms, prefers notes over attachments, and resolves [[#H]] to the note itself', () => {
    expect(resolve(link('[[Concepts/Sigmoid]]'), 'x.md', t)).toBe('Concepts/Sigmoid.md');
    expect(resolve(link('[[Sigmoid.md]]'), 'x.md', t)).toBe('Concepts/Sigmoid.md');
    expect(resolve(link('[[Lecture 3.5]]'), 'x.md', t)).toBe('School/Lecture 3.5.md');
    expect(resolve(link('![[sigmoid.png]]'), 'x.md', t)).toBe('attachments/sigmoid.png');
    expect(resolve(link('[[#Uses]]'), 'Concepts/Sigmoid.md', t)).toBe('Concepts/Sigmoid.md');
    expect(resolve(link('[[Missing]]'), 'x.md', t)).toBeNull();
  });
});

describe('retarget', () => {
  const isOld = (l: { target: string }) => titleKey(l.target) === titleKey('Old');
  it('renames body and property links, keeping headings, aliases and embeds, and skipping code', () => {
    const text = "---\nrelated: '[[Old]]'\nkeep: 1\n---\n[[Old]] [[old#H|x]] ![[Old#H]] `[[Old]]` [[Other]]\n";
    expect(retarget(text, isOld, () => ({ target: "Bob's" }))).toBe(
      '---\nrelated: "[[Bob\'s]]"\nkeep: 1\n---\n[[Bob\'s]] [[Bob\'s#H|x]] ![[Bob\'s#H]] `[[Old]]` [[Other]]\n',
    );
  });
  it('keeps CRLF line endings', () => {
    expect(retarget('# N\r\n\r\nSee [[Old]].\r\n', isOld, () => ({ target: 'New' }))).toBe('# N\r\n\r\nSee [[New]].\r\n');
  });
  it('returns the same string when nothing matches', () => {
    const text = '---\nx: "[[A]]"\n---\n[[A]]\n';
    expect(retarget(text, isOld, () => ({ target: 'New' }))).toBe(text);
  });
});
