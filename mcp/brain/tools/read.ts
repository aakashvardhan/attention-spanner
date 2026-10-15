import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolve } from '../../../src/shared/brain/links';
import { hasRegex, parseQuery } from '../../../src/shared/brain/query';
import { search, toSearchDoc } from '../../../src/shared/brain/search';
import type { SearchRunner } from '../regexSearch';
import type { Vault } from '../vault';
import { fail, guard, ok, READ } from './common';

const lineAt = (body: string, pos: number) => {
  const start = body.lastIndexOf('\n', pos - 1) + 1;
  const end = body.indexOf('\n', pos);
  return body.slice(start, end === -1 ? body.length : end).trim();
};
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export function registerReadTools(server: McpServer, vault: Vault, runRegex: SearchRunner): void {
  server.registerTool(
    'search',
    {
      title: 'Search notes',
      description:
        'Search the vault with Obsidian search syntax: words (all must match), "exact phrase", OR, (groups), -exclude, /regex/, and the operators file:, path:, content:, tag:, line:( ), block:( ), section:( ), task:, task-todo:, task-done:, match-case:, ignore-case:. Returns note titles and paths, best match first.',
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(200).optional() },
      annotations: READ,
    },
    async ({ query, limit }) =>
      guard(vault, async () => {
        const q = parseQuery(query);
        const docs = [...vault.entries.values()].map(toSearchDoc);
        const n = limit ?? 20;
        const r = hasRegex(q) ? await runRegex(query, docs, n) : search(q, docs, { limit: n });
        const lines = r.hits.map((h) => `${h.title} (${h.path})`);
        if (r.partial) lines.push('Partial results: the regular expression was stopped after 2 s.');
        return ok(lines.length ? lines.join('\n') : 'No matches.');
      }),
  );

  server.registerTool(
    'read_note',
    {
      title: 'Read a note',
      description: 'Read a note by title, alias or vault path. Returns its path and full text, frontmatter included. Read a note before edit_note or write_note.',
      inputSchema: { title: z.string().min(1) },
      annotations: READ,
    },
    async ({ title }) =>
      guard(vault, async () => {
        const e = vault.find(title);
        if (!e) return fail(`No note titled "${title}".`);
        const text = await vault.fs.readText(e.path);
        vault.markRead(e.path);
        return ok(`path: ${e.path}\n\n${text ?? ''}`);
      }),
  );

  server.registerTool(
    'backlinks',
    {
      title: 'Notes that link here',
      description: 'List the notes that link to a note (by title, embed or property), each with the line or property the link is in. As in Obsidian, [[alias]] is not a link; write [[Title|alias]].',
      inputSchema: { title: z.string().min(1) },
      annotations: READ,
    },
    async ({ title }) =>
      guard(vault, async () => {
        const e = vault.find(title);
        if (!e) return fail(`No note titled "${title}".`);
        const links = vault.backlinksOf(e.path);
        if (!links.length) return ok(`Nothing links to "${e.title}".`);
        return ok(
          links
            .map(({ from, link }) => {
              const src = vault.entries.get(from)!;
              return `${src.title} (${from}): ${link.property ? `property "${link.property}"` : lineAt(src.body, link.from)}`;
            })
            .join('\n'),
        );
      }),
  );

  server.registerTool(
    'list_moc',
    {
      title: 'Maps of content',
      description: "With no title, list every map of content (notes tagged moc). With a title, list that note's links in order, marking those that do not exist yet.",
      inputSchema: { title: z.string().optional() },
      annotations: READ,
    },
    async ({ title }) =>
      guard(vault, async () => {
        if (!title) {
          const mocs = [...vault.entries.values()].filter((e) => e.tags.includes('moc')).sort((a, b) => (a.path < b.path ? -1 : 1));
          return ok(mocs.length ? mocs.map((e) => `${e.title} (${e.path})`).join('\n') : 'No notes are tagged moc.');
        }
        const e = vault.find(title);
        if (!e) return fail(`No note titled "${title}".`);
        const t = vault.targets();
        const lines = e.links.filter((l) => l.property === null && l.target !== '').map((l) => {
          const p = resolve(l, e.path, t);
          return p ? `- ${vault.entries.get(p)?.title ?? l.target} (${p})` : `- ${l.target} (no such note yet)`;
        });
        return ok(lines.length ? lines.join('\n') : `"${e.title}" has no links.`);
      }),
  );

  server.registerTool(
    'list_folder',
    {
      title: 'List a folder',
      description: 'List the subfolders and notes in a vault folder; the top of the vault when no folder is given.',
      inputSchema: { folder: z.string().optional() },
      annotations: READ,
    },
    async ({ folder }) =>
      guard(vault, async () => {
        const f = (folder ?? '').replace(/^\/+|\/+$/g, '');
        const dirs = (await vault.fs.listDirs(f)).filter((d) => !d.startsWith('.')).map((d) => `${d}/`);
        const notes = [...vault.entries.values()].filter((e) => dirOf(e.path) === f).sort((a, b) => (a.title < b.title ? -1 : 1)).map((e) => `${e.title} (${e.path})`);
        const all = [...dirs, ...notes];
        return ok(all.length ? all.join('\n') : `"${f}" is empty or does not exist.`);
      }),
  );
}
