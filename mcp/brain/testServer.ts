import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseQuery } from '../../src/shared/brain/query';
import { search } from '../../src/shared/brain/search';
import { createServer, type ServerOptions } from './server';
import { Vault } from './vault';

/** A throwaway vault on disk, for tests. */
export async function writeVault(files: Record<string, string | Uint8Array>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'brain-vault-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  return root;
}

/** A server over a throwaway vault, talking to a real MCP client in memory. Regex runs in-process here; the stdio test runs the worker. */
export async function testServer(files: Record<string, string | Uint8Array>, opts: ServerOptions = {}) {
  const root = await writeVault(files);
  const vault = await Vault.open(root, { now: () => new Date(2026, 9, 14, 9, 30) });
  const server = createServer(vault, { runRegex: async (q, docs, limit) => search(parseQuery(q), docs, { limit }), ...opts });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), error: !!r.isError };
  };
  let closed = false;
  return {
    root,
    vault,
    client,
    call,
    // Safe to call twice: a model run closes each vault, and afterEach closes again.
    close: async () => {
      if (closed) return;
      closed = true;
      await client.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
