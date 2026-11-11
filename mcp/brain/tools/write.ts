import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { dailyPath, dailyText, ymd } from '../lib/daily';
import { asList, getField, parseNote, setField, toText } from '../lib/frontmatter';
import { folderProblem, nfc, safeTitle, titleKey } from '../lib/names';
import { planDelete, planMove, planRename, STARRED } from '../lib/rename';
import type { Vault } from '../vault';
import { DESTRUCTIVE, fail, guard, IDEMPOTENT, ok, WRITE } from './common';

export function registerWriteTools(server: McpServer, vault: Vault): void {
  // One at a time, and re-read inside the queue: another call may have changed the vault while this one waited.
  const write = (fn: () => Promise<CallToolResult>) =>
    guard(
      vault,
      () =>
        vault.serial(async () => {
          await vault.refresh();
          return fn();
        }),
      false,
    );
  const noteOr = (title: string) => {
    const e = vault.find(title);
    if (!e) throw new Error(`No note titled "${title}".`);
    return e;
  };

  server.registerTool(
    'daily_note',
    { title: "Today's daily note", description: 'Open the daily note for a date (today by default), creating it in daily/ with only its date heading.', inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }, annotations: IDEMPOTENT },
    async ({ date }) =>
      write(async () => {
        const d = date ? new Date(`${date}T12:00:00`) : vault.now();
        // JavaScript rolls 30 February over into March, so check the date survives the round trip.
        if (date && (Number.isNaN(d.getTime()) || ymd(d) !== date)) return fail(`"${date}" is not a date.`);
        const path = dailyPath(d);
        if (!(await vault.fs.exists(path))) {
          await vault.fs.writeText(path, dailyText(d));
          await vault.refresh();
          await vault.log('daily_note', { path });
        }
        vault.markRead(path);
        return ok(`path: ${path}\n\n${(await vault.fs.readText(path)) ?? ''}`);
      }),
  );

  server.registerTool(
    'create_note',
    {
      title: 'Create a note',
      description: 'Create a new note. The title becomes the file name and must be unique in the vault; characters a file name cannot hold are replaced and the original title is kept in aliases. Goes to Inbox/ unless a folder is given.',
      inputSchema: { title: z.string().min(1), text: z.string(), folder: z.string().optional() },
      annotations: WRITE,
    },
    async ({ title, text, folder }) =>
      write(async () => {
        const f = (folder ?? 'Inbox').replace(/^\/+|\/+$/g, '');
        const problem = folderProblem(f);
        if (problem) return fail(`${problem}.`);
        const wanted = nfc(title).trim();
        const safe = safeTitle(wanted, f);
        const taken = vault.targets().notes;
        for (const k of new Set([safe.title, wanted])) {
          const owner = taken.get(titleKey(k));
          if (owner) return fail(`"${k}" is already used by ${owner}`);
        }
        let body = text;
        if (safe.changed) {
          const n = parseNote(text);
          if (n.error) return fail(`The frontmatter cannot be read (${n.error}); fix it or leave it out.`);
          body = toText(setField(n, 'aliases', [...asList(getField(n, 'aliases')), wanted]));
        }
        const path = f ? `${f}/${safe.title}.md` : `${safe.title}.md`;
        await vault.fs.writeText(path, body);
        await vault.refresh();
        vault.markRead(path);
        await vault.log('create_note', { path });
        return ok(`Created ${path}${safe.changed ? `; the file name cannot hold "${wanted}", so it is in aliases` : ''}.`);
      }),
  );

  server.registerTool(
    'write_note',
    { title: 'Replace a note', description: 'Replace the whole text of an existing note. Read it first; refused if it changed since.', inputSchema: { title: z.string().min(1), text: z.string() }, annotations: DESTRUCTIVE },
    async ({ title, text }) =>
      write(async () => {
        const e = noteOr(title);
        vault.assertFresh(e.path);
        await vault.snapshot([e.path]);
        await vault.fs.writeText(e.path, text);
        await vault.refresh();
        vault.markRead(e.path);
        await vault.log('write_note', { path: e.path });
        return ok(`Saved ${e.path}.`);
      }),
  );

  server.registerTool(
    'edit_note',
    {
      title: 'Edit a note',
      description: 'Replace old_str with new_str in a note. old_str must occur exactly once unless replace_all is set. Read the note first; refused if it changed since.',
      inputSchema: { title: z.string().min(1), old_str: z.string().min(1), new_str: z.string(), replace_all: z.boolean().optional() },
      annotations: WRITE,
    },
    async ({ title, old_str, new_str, replace_all }) =>
      write(async () => {
        const e = noteOr(title);
        vault.assertFresh(e.path);
        const text = (await vault.fs.readText(e.path)) ?? '';
        const count = text.split(old_str).length - 1;
        if (count === 0) return fail('old_str was not found in the note.');
        if (count > 1 && !replace_all) return fail(`old_str occurs ${count} times; include more context or set replace_all`);
        const next = replace_all ? text.split(old_str).join(new_str) : text.replace(old_str, () => new_str);
        await vault.snapshot([e.path]);
        await vault.fs.writeText(e.path, next);
        await vault.refresh();
        vault.markRead(e.path);
        await vault.log('edit_note', { path: e.path, replaced: replace_all ? count : 1 });
        return ok(`Edited ${e.path}.`);
      }),
  );

  server.registerTool(
    'rename_note',
    {
      title: 'Rename a note',
      description: 'Rename a note and rewrite every link to it across the vault (bodies, embeds, properties, starred). Refused if the new title is already a title or alias.',
      inputSchema: { title: z.string().min(1), new_title: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    async ({ title, new_title }) =>
      write(async () => {
        const e = noteOr(title);
        const froms = [...new Set(vault.backlinksOf(e.path).map((b) => b.from))];
        const linkers = await Promise.all(froms.map(async (path) => ({ path, text: (await vault.fs.readText(path)) ?? '' })));
        const r = planRename({ note: { path: e.path, text: (await vault.fs.readText(e.path)) ?? '' }, newTitle: new_title, linkers, titles: vault.targets().notes, starred: await vault.fs.readText(STARRED) });
        if (!r.ok) return fail(r.error);
        await vault.execute(r.plan);
        await vault.log('rename_note', { from: e.path, to: new_title, rewritten: r.rewritten });
        const n = r.rewritten.length;
        return ok(`Renamed "${e.title}" to "${nfc(new_title).trim()}"; updated links in ${n} note${n === 1 ? '' : 's'}.`);
      }),
  );

  server.registerTool(
    'move_note',
    { title: 'Move a note', description: 'Move a note to another folder. Links are title-only, so no link changes.', inputSchema: { title: z.string().min(1), folder: z.string() }, annotations: DESTRUCTIVE },
    async ({ title, folder }) =>
      write(async () => {
        const e = noteOr(title);
        const r = planMove({ note: { path: e.path, text: '' }, folder, paths: new Set([...vault.entries.keys()].map(titleKey)) });
        if (!r.ok) return fail(r.error);
        await vault.execute(r.plan);
        await vault.log('move_note', { from: e.path, folder });
        return ok(`Moved "${e.title}" to ${folder.replace(/^\/+|\/+$/g, '') || 'the top folder'}.`);
      }),
  );

  server.registerTool(
    'delete_note',
    { title: 'Delete a note', description: "Move a note to today's folder in .brain/trash/, where it stays restorable for 30 days.", inputSchema: { title: z.string().min(1) }, annotations: DESTRUCTIVE },
    async ({ title }) =>
      write(async () => {
        const e = noteOr(title);
        const day = ymd(vault.now());
        const taken = new Set((await vault.fs.list(`.brain/trash/${day}`)).map(titleKey));
        const r = planDelete({ note: { path: e.path, text: '' }, date: day, taken });
        if (!r.ok) return fail(r.error);
        await vault.execute(r.plan);
        await vault.log('delete_note', { path: e.path });
        return ok(`Moved "${e.title}" to .brain/trash/${day}/. Restore it from there within 30 days.`);
      }),
  );
}
