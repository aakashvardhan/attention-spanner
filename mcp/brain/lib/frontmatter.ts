import { parse as parseYaml } from 'yaml';

/**
 * Frontmatter as a flat subset: each key holds a scalar or a list of scalars.
 * Values are read by the `yaml` library, so they mean exactly what YAML says.
 * The raw lines are kept, so a save that changes nothing, or one key, leaves
 * every other byte as it was (spec, Frontmatter; Done when, Zero loss).
 */

export type FmScalar = string | number | boolean | null;
export type FmValue = FmScalar | FmScalar[];
export interface FmField { key: string; value: FmValue }
export interface Note {
  /** Text before the body, exactly as read: BOM, fences, frontmatter, line endings. '' when there is no frontmatter. */
  head: string;
  body: string;
  fields: FmField[];
  /** Set when there is frontmatter outside the subset. The note then opens raw, and `fields` is empty. */
  error: string | null;
  eol: '\n' | '\r\n';
}

const KEY_LINE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[\p{L}\p{N}_][^:#]*?)[ \t]*:(?=[ \t]|$)/u;
const OPEN = /^---[ \t]*\r?\n/;

interface Head { bom: string; open: string; inner: string; close: string; after: number }

function splitHead(text: string): Head | null {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const open = OPEN.exec(text.slice(bom.length))?.[0];
  if (!open) return null;
  const start = bom.length + open.length;
  for (let pos = start; pos <= text.length; ) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl + 1;
    if (/^---[ \t]*\r?\n?$/.test(text.slice(pos, end))) return { bom, open, inner: text.slice(start, pos), close: text.slice(pos, end), after: end };
    if (nl === -1) return null;
    pos = end;
  }
  return null;
}

const innerLines = (inner: string): string[] => {
  const lines = inner.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

function unquoteKey(k: string): string {
  if (k.startsWith('"')) return JSON.parse(k) as string;
  if (k.startsWith("'")) return k.slice(1, -1).replace(/''/g, "'");
  return k.trimEnd();
}

/** Top-level keys and their line numbers. Null when a line is neither a key, a continuation nor a comment. */
function keyLines(lines: string[]): { key: string; line: number }[] | null {
  const out: { key: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' || /^[ \t#]/.test(l) || /^-(\s|$)/.test(l)) continue;
    const m = KEY_LINE.exec(l);
    if (!m) return null;
    out.push({ key: unquoteKey(m[1]), line: i });
  }
  return out;
}

const isScalar = (v: unknown): v is FmScalar => v === null || ['string', 'number', 'boolean'].includes(typeof v);

function readFields(inner: string): { fields: FmField[]; error: string | null } {
  let data: unknown;
  try {
    data = parseYaml(inner, { uniqueKeys: true });
  } catch (e) {
    return { fields: [], error: `invalid YAML: ${(e as Error).message.split('\n')[0]}` };
  }
  if (data === null || data === undefined) return { fields: [], error: null };
  if (typeof data !== 'object' || Array.isArray(data)) return { fields: [], error: 'frontmatter is not a list of keys' };
  const fields: FmField[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!(isScalar(value) || (Array.isArray(value) && value.every(isScalar)))) return { fields: [], error: `"${key}" holds a nested value` };
    fields.push({ key, value: value as FmValue });
  }
  const keys = keyLines(innerLines(inner));
  // Compare as sets: JavaScript objects list numeric keys first, whatever order the file has.
  const sorted = (xs: string[]) => [...xs].sort().join('\0');
  if (!keys || sorted(keys.map((k) => k.key)) !== sorted(fields.map((f) => f.key))) {
    return { fields: [], error: 'frontmatter layout is outside the flat subset' };
  }
  return { fields, error: null };
}

export function parseNote(text: string): Note {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const h = splitHead(text);
  if (!h) return { head: '', body: text, fields: [], error: null, eol };
  return { head: text.slice(0, h.after), body: text.slice(h.after), eol, ...readFields(h.inner) };
}

export const toText = (note: Note): string => note.head + note.body;
export const getField = (note: Note, key: string): FmValue | undefined => note.fields.find((f) => f.key === key)?.value;

export function asList(v: FmValue | undefined): string[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => x !== null && typeof x !== 'boolean').map(String);
}

const sameAsPlain = (v: string) => {
  try {
    return parseYaml(v) === v;
  } catch {
    return false;
  }
};

function scalar(v: FmScalar): string {
  if (v === null) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('frontmatter numbers must be finite');
    return String(v);
  }
  if (typeof v === 'boolean') return String(v);
  const plain = v !== '' && v === v.trim() && !/[\n\r\t,[\]{}#&*!|>'"%@`]|: |:$|^[-?:]/.test(v) && sameAsPlain(v);
  // JSON strings are valid YAML double-quoted scalars; YAML also wants these characters escaped.
  return plain ? v : JSON.stringify(v).replace(/[\u007f-\u009f﻿￾￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const render = (v: FmValue): string => (Array.isArray(v) ? `[${v.map(scalar).join(', ')}]` : scalar(v));
const renderKey = (k: string): string =>
  /^[\p{L}\p{N}_][\p{L}\p{N}_ -]*$/u.test(k) && k === k.trim() && !['null', 'true', 'false', '~'].includes(k.toLowerCase()) ? k : JSON.stringify(k);

function edit(note: Note, key: string, line: string): Note {
  if (note.error) throw new Error(`cannot edit frontmatter: ${note.error}`);
  const text = toText(note);
  const h = splitHead(text);
  if (!h) {
    // A BOM stays at the start of the file, not inside the body.
    const bom = text.startsWith('﻿') ? '﻿' : '';
    return parseNote(`${bom}---${note.eol}${line}${note.eol}---${note.eol}${text.slice(bom.length)}`);
  }
  // The frontmatter's own line ending: a file can mix LF frontmatter with a CRLF body.
  const eol = h.open.endsWith('\r\n') ? '\r\n' : '\n';
  const lines = innerLines(h.inner);
  const k = (keyLines(lines) ?? []).find((x) => x.key === key);
  if (k) {
    let end = k.line + 1;
    while (end < lines.length && (/^[ \t]+\S/.test(lines[end]) || /^-(\s|$)/.test(lines[end]))) end++;
    lines.splice(k.line, end - k.line, line);
  } else lines.push(line);
  return parseNote(h.bom + h.open + lines.map((l) => l + eol).join('') + h.close + note.body);
}

export const setField = (note: Note, key: string, value: FmValue): Note => edit(note, key, `${renderKey(key)}: ${render(value)}`);
