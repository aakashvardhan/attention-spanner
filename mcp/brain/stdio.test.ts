import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeVault } from './testServer';

type Text = { content: { text: string }[] };
let out = '';
let root = '';
let client: Client;

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'brain-dist-'));
  // The same bundle `npm run build:mcp` makes, so this tests what Claude Code actually runs.
  await build({
    entryPoints: ['mcp/brain/server.ts', 'mcp/brain/searchWorker.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outdir: out,
    outExtension: { '.js': '.mjs' },
    banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
    logLevel: 'error',
  });
  root = await writeVault({ 'Concepts/Slow.md': `# Slow\n\n${'a'.repeat(32)}!\n`, 'Concepts/Fast.md': '# Fast\n\nfine\n' });
  client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(out, 'server.mjs')], env: { ...process.env, BRAIN_VAULT: root } as Record<string, string> }));
}, 60_000);

afterAll(async () => {
  await client?.close();
  await rm(out, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

describe('the bundled server over stdio', () => {
  it('offers all fifteen tools', async () => {
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'backlinks', 'create_note', 'daily_note', 'delete_note', 'edit_note', 'list_folder', 'list_moc', 'move_note',
      'promote_staging', 'read_note', 'rename_note', 'search', 'stage_attachment', 'stage_note', 'write_note',
    ]);
  });
  it('reads and writes the vault BRAIN_VAULT names', async () => {
    await client.callTool({ name: 'create_note', arguments: { title: 'Hello', text: '# Hello\n' } });
    const r = (await client.callTool({ name: 'read_note', arguments: { title: 'Hello' } })) as Text;
    expect(r.content[0].text).toBe('path: Inbox/Hello.md\n\n# Hello\n');
  });
  it('stops a catastrophic regex at 2 s and keeps answering', async () => {
    const t0 = Date.now();
    const r = (await client.callTool({ name: 'search', arguments: { query: '/(a+)+$/' } })) as Text;
    expect(r.content[0].text).toContain('Partial results');
    expect(Date.now() - t0).toBeLessThan(5_000);
    const after = (await client.callTool({ name: 'search', arguments: { query: 'fine' } })) as Text;
    expect(after.content[0].text).toBe('Fast (Concepts/Fast.md)');
  }, 15_000);
});
