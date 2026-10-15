import type { IndexEntry } from './entry';
import { overlaps } from './links';
import { nfc } from './names';

/** Places a note is named but not linked (spec, Brain page 4). Offsets are into the whole file. */
export interface Mention { path: string; from: number; to: number; text: string }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);

export function unlinkedMentions(target: { path: string; title: string; aliases: string[] }, entries: IndexEntry[]): Mention[] {
  // Longest first, so "Logistic function" wins over a shorter alias inside it.
  const names = [target.title, ...target.aliases].map(nfc).filter((n) => [...n.trim()].length >= 3).sort((a, b) => b.length - a.length);
  const out: Mention[] = [];
  for (const e of entries) {
    if (e.path === target.path) continue;
    const blocked: [number, number][] = [...e.code, ...e.links.filter((l) => l.from >= 0).map((l): [number, number] => [l.from, l.to])];
    const taken: [number, number][] = [];
    for (const name of names) {
      for (const m of e.body.matchAll(new RegExp(escape(name), 'giu'))) {
        const from = m.index;
        const to = from + m[0].length;
        if (wordChar(e.body[from - 1]) || wordChar(e.body[to]) || overlaps(blocked, from, to) || overlaps(taken, from, to)) continue;
        taken.push([from, to]);
        out.push({ path: e.path, from: e.bodyStart + from, to: e.bodyStart + to, text: m[0] });
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.from - b.from);
}

export function linkMention(text: string, m: Mention, title: string): string {
  return text.slice(0, m.from) + `[[${m.text === title ? title : `${title}|${m.text}`}]]` + text.slice(m.to);
}
