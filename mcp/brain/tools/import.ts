import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { safeTitle, titleKey, titleOf } from '../lib/names';
import { newPlanId, type Step } from '../lib/plan';
import type { Vault } from '../vault';
import { DESTRUCTIVE, fail, guard, IDEMPOTENT, IDEMPOTENT_OPEN, ok } from './common';

const AREA = /^[\p{L}\p{N}][\p{L}\p{N} _&-]{0,60}$/u;
const MAX_BYTES = 100 * 1024 * 1024;
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The name with its extension set aside, made safe for Windows, Drive and links; equal to `name` when it already is. */
const safeName = (name: string, folder = '') => {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  return safeTitle(stem, folder).title + ext;
};

/** Where a staged note may go: a note or .base anywhere notes live, or a verbatim page under sources/notion/. */
function stagePathProblem(path: string): string | null {
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..') || path.includes('\\')) return 'not a vault path';
  if (/^(\.brain|\.obsidian|attachments)(\/|$)/i.test(path)) return 'that folder is not staged through stage_note';
  if (!/\.(md|base)$/i.test(path)) return 'only .md and .base files are staged as notes';
  // Every folder and file name syncs to Windows through Drive, sources/ included.
  for (let i = 0; i < parts.length - 1; i++) {
    const safe = safeTitle(parts[i]).title;
    if (safe !== parts[i]) return `folder "${parts[i]}" cannot be a name on Windows; use "${safe}"`;
  }
  const name = parts[parts.length - 1];
  const safe = safeName(name, parts.slice(0, -1).join('/'));
  if (safe !== name) return /^sources\//i.test(path) ? `"${name}" cannot be a file name on Windows; use "${safe}"` : `"${titleOf(path)}" cannot be a file name; use "${titleOf(safe)}" and keep the original in aliases`;
  return null;
}

export function registerImportTools(server: McpServer, vault: Vault, fetchImpl: typeof fetch = fetch): void {
  server.registerTool(
    'stage_note',
    {
      title: 'Stage an imported note',
      description: 'Write a note for the Notion import into .brain/staging/<area>/, at the vault path it will be promoted to. Nothing in the vault changes until promote_staging.',
      inputSchema: { area: z.string().regex(AREA), path: z.string().min(1), text: z.string() },
      annotations: IDEMPOTENT,
    },
    async ({ area, path, text }) =>
      guard(vault, async () => {
        const problem = stagePathProblem(path);
        if (problem) return fail(`${path}: ${problem}.`);
        await vault.fs.writeText(`.brain/staging/${area}/${path}`, text);
        return ok(`Staged ${path} for ${area}.`);
      }),
  );

  server.registerTool(
    'stage_attachment',
    {
      title: 'Stage an attachment',
      description: 'Download a file (a Notion signed URL) into .brain/staging/<area>/attachments/<filename>. Signed URLs expire: on an HTTP error, fetch a fresh URL and retry.',
      inputSchema: { area: z.string().regex(AREA), url: z.string().url(), filename: z.string().min(1).max(200) },
      annotations: IDEMPOTENT_OPEN,
    },
    async ({ area, url, filename }) =>
      guard(vault, async () => {
        if (!url.startsWith('https://')) return fail('Only https URLs are fetched.');
        if (/[/\\]|^\.|\0/.test(filename)) return fail(`"${filename}" is not a file name.`);
        const safe = safeName(filename, 'attachments');
        if (safe !== filename) return fail(`"${filename}" cannot be a file name on Windows; use "${safe}".`);
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) return fail(`Download failed with HTTP ${res.status}; fetch a fresh signed URL from Notion and retry.`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > MAX_BYTES) return fail(`${filename} is ${bytes.length} bytes, over the 100 MB limit.`);
        await vault.fs.writeBytes(`.brain/staging/${area}/attachments/${filename}`, bytes);
        return ok(`Staged attachments/${filename} (${bytes.length} bytes, sha256 ${sha256(bytes)}).`);
      }),
  );

  server.registerTool(
    'promote_staging',
    {
      title: 'Promote a staged area',
      description: 'Move everything staged for an area into the vault in one journaled step. Refused unless the fidelity audit passed for exactly what is staged, and on any title or attachment clash.',
      inputSchema: { area: z.string().regex(AREA) },
      annotations: DESTRUCTIVE,
    },
    async ({ area }) =>
      guard(vault, () =>
        vault.serial(async () => {
          await vault.refresh();
          const dir = `.brain/staging/${area}`;
          const staged = (await vault.fs.walk(dir)).map((f) => f.path.slice(dir.length + 1));
          if (!staged.length) return fail(`Nothing is staged for ${area}.`);
          const auditText = await vault.fs.readText(`.brain/reports/${area}-audit.json`);
          const audit = auditText ? (JSON.parse(auditText) as { pass?: boolean; digest?: string }) : null;
          if (!audit?.pass || audit.digest !== (await vault.stagingDigest(area))) {
            return fail(`${area} has no passing fidelity audit for exactly what is staged. Run the audit (npm run brain:audit) on the current staging first.`);
          }
          const owners = vault.targets().notes;
          const seen = new Map<string, string>();
          for (const rel of staged) {
            if (!/\.md$/i.test(rel) || /^sources\//i.test(rel) || /^attachments\//i.test(rel)) continue;
            const key = titleKey(titleOf(rel));
            const owner = owners.get(key);
            if (owner && titleKey(owner) !== titleKey(rel)) return fail(`"${titleOf(rel)}" is already used by ${owner}`);
            const twin = seen.get(key);
            if (twin) return fail(`"${titleOf(rel)}" is staged twice: ${twin} and ${rel}`);
            seen.set(key, rel);
          }
          for (const rel of staged.filter((r) => /^attachments\//i.test(r))) {
            const existing = await vault.fs.readBytes(rel);
            const incoming = await vault.fs.readBytes(`${dir}/${rel}`);
            if (existing && incoming && sha256(existing) !== sha256(incoming)) return fail(`${rel} already exists with different content; stage it under another name.`);
          }
          const steps: Step[] = [...staged.map((rel): Step => ({ op: 'copy', from: `${dir}/${rel}`, to: rel })), ...staged.map((rel): Step => ({ op: 'remove', path: `${dir}/${rel}` }))];
          await vault.execute({ id: newPlanId(), label: `promote ${area}`, steps }, { promoting: true });
          await vault.log('promote_staging', { area, files: staged.length });
          return ok(`Promoted ${staged.length} files from ${area}.`);
        }),
      ),
  );
}
