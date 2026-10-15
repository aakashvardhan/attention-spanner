import { structure } from './blocks';
import { parseNote, setField, type FmField, type FmValue } from './frontmatter';
import { nfc, titleKey } from './names';

/** A wiki link. `from`/`to` are offsets into the text it was read from; -1 for links in properties. */
export interface Link { target: string; heading: string | null; alias: string | null; embed: boolean; from: number; to: number; property: string | null }
/** What links can point at: notes by title or alias, attachments by file name. Keys are titleKey()s, values paths. */
export interface Targets { notes: Map<string, string>; files: Map<string, string> }

const WIKI = /(!?)\[\[([^[\]|#\n]*)(?:#([^[\]|\n]*))?(?:\|([^[\]\n]*))?\]\]/g;

export const overlaps = (ranges: [number, number][], from: number, to: number): boolean => ranges.some(([a, b]) => from < b && to > a);

function toLink(m: RegExpExecArray | RegExpMatchArray, from: number, property: string | null): Link {
  return {
    target: nfc(m[2].trim()),
    heading: m[3]?.trim() || null,
    alias: m[4] ?? null,
    embed: m[1] === '!',
    from,
    to: property === null ? from + m[0].length : -1,
    property,
  };
}

export function wikiLinks(text: string, code: [number, number][] = []): Link[] {
  const out: Link[] = [];
  for (const m of text.matchAll(WIKI)) {
    const from = m.index;
    if (overlaps(code, from, from + m[0].length)) continue;
    const l = toLink(m, from, null);
    if (l.target || l.heading) out.push(l);
  }
  return out;
}

/** Obsidian reads a property value that is exactly one wiki link as a link. */
export function propertyLinks(fields: FmField[]): Link[] {
  const out: Link[] = [];
  for (const f of fields) {
    for (const v of Array.isArray(f.value) ? f.value : [f.value]) {
      if (typeof v !== 'string') continue;
      const m = /^\s*(!?)\[\[([^[\]|#\n]*)(?:#([^[\]|\n]*))?(?:\|([^[\]\n]*))?\]\]\s*$/.exec(v);
      if (m && m[2].trim()) out.push({ ...toLink(m, -1, f.key), from: -1 });
    }
  }
  return out;
}

/** Notes first, as Obsidian does, so "Lecture 3.5" is a note before it is a file called "3.5". */
export function resolve(link: Link, selfPath: string, t: Targets): string | null {
  if (link.target === '') return selfPath;
  const name = link.target.slice(link.target.lastIndexOf('/') + 1);
  return t.notes.get(titleKey(name.replace(/\.md$/i, ''))) ?? t.files.get(titleKey(name)) ?? null;
}

export function formatLink(l: Pick<Link, 'target' | 'heading' | 'alias' | 'embed'>): string {
  return `${l.embed ? '!' : ''}[[${l.target}${l.heading !== null ? `#${l.heading}` : ''}${l.alias !== null ? `|${l.alias}` : ''}]]`;
}

export function rewriteLinks(text: string, code: [number, number][], change: (l: Link) => Partial<Link> | null): string {
  let out = '';
  let last = 0;
  for (const l of wikiLinks(text, code)) {
    const c = change(l);
    if (!c) continue;
    out += text.slice(last, l.from) + formatLink({ ...l, ...c });
    last = l.to;
  }
  return last === 0 ? text : out + text.slice(last);
}

/**
 * Rewrites the links `match` picks, in the body (skipping code) and in
 * properties. Properties go through setField so YAML quoting stays valid
 * whatever the new title contains.
 */
export function retarget(text: string, match: (l: Link) => boolean, change: (l: Link) => Partial<Link>): string {
  let note = parseNote(text);
  const pick = (l: Link) => (match(l) ? change(l) : null);
  if (!note.error) {
    for (const f of note.fields) {
      const values = Array.isArray(f.value) ? f.value : [f.value];
      let touched = false;
      const next = values.map((v) => {
        if (typeof v !== 'string') return v;
        const r = rewriteLinks(v, [], pick);
        if (r !== v) touched = true;
        return r;
      });
      if (touched) note = setField(note, f.key, (Array.isArray(f.value) ? next : next[0]) as FmValue);
    }
  }
  return note.head + rewriteLinks(note.body, structure(note.body).code, pick);
}
