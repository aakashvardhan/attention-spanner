import { structure, type Block, type Heading, type Task } from './blocks';
import { asList, getField, parseNote, type FmField } from './frontmatter';
import { overlaps, propertyLinks, resolve, wikiLinks, type Link, type Targets } from './links';
import { nfc, titleKey, titleOf } from './names';

/** What the index keeps per note (spec, Index entry). Offsets in links, headings, blocks, tasks and code are into `body`. */
export interface IndexEntry {
  path: string;
  title: string;
  aliases: string[];
  tags: string[];
  fields: FmField[];
  fmError: string | null;
  bodyStart: number;
  body: string;
  links: Link[];
  headings: Heading[];
  blocks: Block[];
  tasks: Task[];
  code: [number, number][];
}

const TAG = /(^|[\s(])#([\p{L}\p{N}_/-]+)/gu;

/** Obsidian's inline tags: "#" after a space or line start, not all digits, not in code. */
export function inlineTags(body: string, code: [number, number][]): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(TAG)) {
    const from = m.index + m[1].length;
    if (/^\p{N}+$/u.test(m[2]) || overlaps(code, from, from + 1 + m[2].length)) continue;
    out.push(m[2]);
  }
  return out;
}

export function buildEntry(path: string, text: string): IndexEntry {
  const note = parseNote(text);
  const st = structure(note.body);
  const tags = [...new Set([...asList(getField(note, 'tags')).map((t) => t.replace(/^#/, '')), ...inlineTags(note.body, st.code)])];
  return {
    path,
    title: titleOf(path),
    aliases: asList(getField(note, 'aliases')).map(nfc),
    tags,
    fields: note.fields,
    fmError: note.error,
    bodyStart: note.head.length,
    body: note.body,
    links: [...wikiLinks(note.body, st.code), ...propertyLinks(note.fields)],
    headings: st.headings,
    blocks: st.blocks,
    tasks: st.tasks,
    code: st.code,
  };
}

export function targetsOf(entries: IndexEntry[], files: Iterable<string>): Targets {
  const notes = new Map<string, string>();
  for (const e of entries) if (!notes.has(titleKey(e.title))) notes.set(titleKey(e.title), e.path);
  for (const e of entries) for (const a of e.aliases) if (!notes.has(titleKey(a))) notes.set(titleKey(a), e.path);
  const byName = new Map<string, string>();
  for (const f of files) byName.set(titleKey(f.slice(f.lastIndexOf('/') + 1)), f);
  return { notes, files: byName };
}

export function backlinks(entries: Iterable<IndexEntry>, t: Targets): Map<string, { from: string; link: Link }[]> {
  const out = new Map<string, { from: string; link: Link }[]>();
  for (const e of entries) {
    for (const link of e.links) {
      const to = resolve(link, e.path, t);
      if (!to || to === e.path) continue;
      const list = out.get(to) ?? [];
      list.push({ from: e.path, link });
      out.set(to, list);
    }
  }
  return out;
}

/** Titles must be unique ignoring case; a file made outside the extension can break that, so it is reported, not hidden. */
export function duplicateTitles(entries: IndexEntry[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const e of entries) groups.set(titleKey(e.title), [...(groups.get(titleKey(e.title)) ?? []), e.path]);
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort());
}

export async function contentHash(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
