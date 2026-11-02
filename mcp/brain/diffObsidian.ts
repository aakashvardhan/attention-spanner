import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { IndexEntry } from './lib/entry';
import { resolve, type Targets } from './lib/links';
import { nfc } from './lib/names';
import { reportsDir, vaultPath } from './args';
import { Vault } from './vault';

/** What Obsidian's metadata cache says about one note, in the shape mcp/brain/obsidian/dump.js writes. */
export interface FileView { headings: { text: string; level: number }[]; tags: string[]; resolved: Record<string, number>; unresolved: Record<string, number> }
export interface ObsidianDump { obsidian: string; at?: string; files: Record<string, FileView> }
export interface Difference { path: string; field: 'missing' | 'extra' | keyof FileView; ours: unknown; obsidian: unknown }
/** A difference kept on purpose. Every one needs a reason, and a deviation that no longer applies fails the test. */
export interface Deviation { path: string; field: string; reason: string }

export function ourView(e: IndexEntry, t: Targets): FileView {
  const resolved: Record<string, number> = {};
  const unresolved: Record<string, number> = {};
  for (const l of e.links) {
    const p = resolve(l, e.path, t);
    if (p) resolved[nfc(p)] = (resolved[nfc(p)] ?? 0) + 1;
    else unresolved[l.target] = (unresolved[l.target] ?? 0) + 1;
  }
  return { headings: e.headings.map((h) => ({ text: h.text, level: h.level })), tags: [...e.tags].sort(), resolved, unresolved };
}

const canon = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

export function diffObsidian(dump: ObsidianDump, entries: IndexEntry[], t: Targets, deviations: Deviation[] = []): Difference[] {
  const ours = new Map(entries.map((e) => [nfc(e.path), ourView(e, t)]));
  const theirs = new Map(
    Object.entries(dump.files).map(([p, v]) => [nfc(p), { ...v, tags: [...v.tags].sort(), resolved: Object.fromEntries(Object.entries(v.resolved).map(([k, n]) => [nfc(k), n])) }]),
  );
  const kept = (path: string, field: string) => deviations.some((d) => d.path === path && d.field === field);
  const out: Difference[] = [];
  for (const [path, o] of theirs) {
    const u = ours.get(path);
    if (!u) {
      if (!kept(path, 'missing')) out.push({ path, field: 'missing', ours: null, obsidian: o });
      continue;
    }
    for (const field of ['headings', 'tags', 'resolved', 'unresolved'] as const) {
      if (canon(u[field]) !== canon(o[field]) && !kept(path, field)) out.push({ path, field, ours: u[field], obsidian: o[field] });
    }
  }
  for (const [path, u] of ours) if (!theirs.has(path) && !kept(path, 'extra')) out.push({ path, field: 'extra', ours: u, obsidian: null });
  return out;
}

/** `diff-obsidian`: compare the real vault with the dump Obsidian wrote for it (stop A in plan 2). */
export async function diffObsidianCmd(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { vault: { type: 'string' } } });
  const root = vaultPath(values.vault);
  const dump = JSON.parse(await readFile(join(root, '.brain', 'obsidian-dump.json'), 'utf8')) as ObsidianDump;
  const deviations = await readFile(join(root, '.brain', 'obsidian-deviations.json'), 'utf8').then((s) => JSON.parse(s) as Deviation[], () => []);
  const v = await Vault.open(root, { maintain: false });
  const diff = diffObsidian(dump, [...v.entries.values()], v.targets(), deviations);
  await writeFile(join(await reportsDir(root), 'obsidian-diff.json'), JSON.stringify({ obsidian: dump.obsidian, at: new Date().toISOString(), diff }, null, 1));
  const unresolved = Object.values(dump.files).reduce((n, f) => n + Object.values(f.unresolved).reduce((a, b) => a + b, 0), 0);
  console.log(`${diff.length} differences from Obsidian ${dump.obsidian}; Obsidian reports ${unresolved} unresolved links.`);
  if (diff.length || unresolved) process.exitCode = 1;
}
