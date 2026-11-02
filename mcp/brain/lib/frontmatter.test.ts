import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { asList, getField, parseNote, removeField, setField, toText } from './frontmatter';
import { FC } from './testing';

const NOTE = '---\ncreated: 2026-02-11\ntags: [concept]\naliases:\n  - Logistic function\nurl: https://arxiv.org/abs/1234.5678  # paper notes only\n---\n# Sigmoid\n';

describe('parseNote', () => {
  it('reads flat fields and keeps the body', () => {
    const n = parseNote(NOTE);
    expect(n.error).toBeNull();
    expect(n.fields).toEqual([
      { key: 'created', value: '2026-02-11' },
      { key: 'tags', value: ['concept'] },
      { key: 'aliases', value: ['Logistic function'] },
      { key: 'url', value: 'https://arxiv.org/abs/1234.5678' },
    ]);
    expect(n.body).toBe('# Sigmoid\n');
  });
  it('treats a note without frontmatter, or with an unclosed fence, as all body', () => {
    expect(parseNote('# Hi\n')).toMatchObject({ head: '', body: '# Hi\n', fields: [] });
    expect(parseNote('---\ntags: [a]\n# no close\n')).toMatchObject({ head: '', fields: [] });
  });
  it('marks frontmatter outside the flat subset instead of misreading it', () => {
    expect(parseNote('---\na:\n  b: 1\n---\n').error).toMatch(/nested/);
    expect(parseNote('---\na: [1\n---\n').error).toMatch(/invalid YAML/);
    expect(parseNote('---\na: 1\na: 2\n---\n').error).toMatch(/invalid YAML/);
  });
  it('keeps a BOM and CRLF line endings in the head', () => {
    const t = '﻿---\r\ntags: [a]\r\n---\r\nbody\r\n';
    const n = parseNote(t);
    expect(n.eol).toBe('\r\n');
    expect(getField(n, 'tags')).toEqual(['a']);
    expect(toText(n)).toBe(t);
  });
});

// Frontmatter written in the layouts people and Obsidian actually use.
const KEYWORDS = new Set(['null', 'true', 'false']);
const key = fc.stringMatching(/^[a-z]([a-z0-9_ ]{0,8}[a-z0-9])?$/).filter((k) => !KEYWORDS.has(k));
const line = fc.string({ maxLength: 12 }).filter((s) => !/[\r\n]/.test(s));
const scalarText = fc.oneof(
  line.map((s) => JSON.stringify(s)),
  line.map((s) => `'${s.replace(/'/g, "''")}'`),
  fc.integer().map(String),
  fc.boolean().map(String),
  fc.constant('null'),
  fc.constantFrom('2026-02-11', 'plain words', 'Logistic function'),
);
const valueText = fc.oneof(
  scalarText.map((t) => ` ${t}`),
  fc.array(scalarText, { maxLength: 4 }).map((a) => ` [${a.join(', ')}]`),
  fc.array(scalarText, { minLength: 1, maxLength: 4 }).map((a) => a.map((t) => `\n  - ${t}`).join('')),
);
const doc = fc
  .uniqueArray(fc.tuple(key, valueText, fc.boolean()), { selector: ([k]) => k, maxLength: 6 })
  .map((fs) => fs.map(([k, v, comment]) => `${k}:${v}${comment && !v.includes('\n') ? '  # note' : ''}`).join('\n'));

describe('round trip', () => {
  it('toText(parseNote(x)) is byte-identical for any text', () => {
    fc.assert(fc.property(fc.string({ unit: 'grapheme', maxLength: 200 }), (s) => toText(parseNote(s)) === s), FC);
  });
  it('is byte-identical for generated frontmatter, with either line ending', () => {
    fc.assert(
      fc.property(doc, fc.constantFrom('\n', '\r\n'), (d, eol) => {
        const t = `---${eol}${d.replace(/\n/g, eol)}${eol}---${eol}# Body${eol}`;
        return toText(parseNote(t)) === t;
      }),
      FC,
    );
  });
});

describe('oracle: the yaml library', () => {
  it('reads every generated frontmatter exactly as YAML itself does', () => {
    fc.assert(
      fc.property(doc, (d) => {
        const n = parseNote(`---\n${d}\n---\nbody\n`);
        expect(n.error).toBeNull();
        expect(Object.fromEntries(n.fields.map((f) => [f.key, f.value]))).toEqual(parseYaml(d) ?? {});
      }),
      FC,
    );
  });
});

const flatScalar = fc.oneof(
  fc.string({ unit: 'grapheme', maxLength: 20 }),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }).map((x) => (Object.is(x, -0) ? 0 : x)),
  fc.boolean(),
  fc.constant(null),
);

describe('setField', () => {
  it('rewrites only the key it changes', () => {
    const n = setField(parseNote(NOTE), 'tags', ['concept', 'ml']);
    expect(toText(n)).toBe(NOTE.replace('tags: [concept]', 'tags: [concept, ml]'));
  });
  it('replaces a block list as a whole and removes a key with its lines', () => {
    expect(toText(setField(parseNote(NOTE), 'aliases', ['Logit']))).toContain('aliases: [Logit]\nurl:');
    expect(toText(removeField(parseNote(NOTE), 'aliases'))).toBe(NOTE.replace('aliases:\n  - Logistic function\n', ''));
  });
  it('keeps CRLF when editing a note written on Windows', () => {
    const t = '---\r\ntags: [a]\r\nx: 1\r\n---\r\nbody\r\n';
    expect(toText(setField(parseNote(t), 'tags', ['a', 'b']))).toBe('---\r\ntags: [a, b]\r\nx: 1\r\n---\r\nbody\r\n');
  });
  it('adds frontmatter to a note that has none', () => {
    expect(toText(setField(parseNote('# Hi\n'), 'tags', ['moc']))).toBe('---\ntags: [moc]\n---\n# Hi\n');
  });
  it('round-trips any flat value through YAML', () => {
    fc.assert(
      fc.property(fc.oneof(flatScalar, fc.array(flatScalar, { maxLength: 4 })), (v) => {
        const n = setField(parseNote('---\na: 1\n---\nbody'), 'k', v);
        expect(n.error).toBeNull();
        expect(getField(n, 'k')).toEqual(v);
        expect(getField(n, 'a')).toBe(1);
      }),
      FC,
    );
  });
  it('refuses to edit frontmatter it cannot read', () => {
    expect(() => setField(parseNote('---\na:\n  b: 1\n---\n'), 'a', 1)).toThrow(/cannot edit/);
  });
});

describe('asList', () => {
  it('turns a scalar or list into strings and drops nulls', () => {
    expect(asList(['a', 1, null])).toEqual(['a', '1']);
    expect(asList('x')).toEqual(['x']);
    expect(asList(undefined)).toEqual([]);
  });
});
