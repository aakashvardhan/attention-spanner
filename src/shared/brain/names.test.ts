import { describe, expect, it } from 'vitest';
import { MAX_NAME_BYTES, MAX_PATH_CHARS, safeTitle, shortHash, titleKey, titleOf } from './names';

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('safeTitle', () => {
  it('replaces characters Windows, Drive or [[links]] reject', () => {
    expect(safeTitle('A/B: C? "D" <E> |F| #G ^H [I]')).toEqual({ title: 'A-B- C- -D- -E- -F- -G -H -I-', changed: true });
  });
  it('drops trailing dots and spaces, and suffixes reserved device names', () => {
    expect(safeTitle('Notes. ').title).toBe('Notes');
    expect(safeTitle('CON').title).toBe('CON_');
    expect(safeTitle('lpt1').title).toBe('lpt1_');
    expect(safeTitle('   ')).toEqual({ title: 'Untitled', changed: true });
  });
  it('normalises to NFC without calling that a change', () => {
    expect(safeTitle('Café')).toEqual({ title: 'Café', changed: false });
  });
  it('cuts long names on a character boundary and adds a stable hash', () => {
    const long = '\u{1D465}'.repeat(100);
    const t = safeTitle(long).title;
    expect(bytes(t + '.md')).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(t.endsWith(' ' + shortHash(long))).toBe(true);
    expect([...t.replace(/ \w{6}$/, '')].every((c) => c === '\u{1D465}')).toBe(true);
  });
  it('keeps the whole relative path under the Windows budget', () => {
    const folder = 'f'.repeat(50);
    expect(folder.length + 1 + safeTitle('a'.repeat(300), folder).title.length + 3).toBeLessThanOrEqual(MAX_PATH_CHARS);
  });
});

describe('titleKey and titleOf', () => {
  it('compares titles ignoring case and Unicode form', () => {
    expect(titleKey('Café')).toBe(titleKey('CAFÉ'));
  });
  it('takes the title from a path, in NFC', () => {
    expect(titleOf('School/DL Class/Lecture 3.md')).toBe('Lecture 3');
    expect(titleOf('Concepts/Café.md')).toBe('Café');
  });
});
