import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { vaultPath } from './args';
import { workerSearch, type SearchRunner } from './regexSearch';
import { registerImportTools } from './tools/import';
import { registerReadTools } from './tools/read';
import { registerWriteTools } from './tools/write';
import { Vault } from './vault';

export interface ServerOptions { runRegex?: SearchRunner; fetch?: typeof fetch }

/** The vault MCP server (spec, Vault MCP server). Read tools need no approval; Claude Code asks before every write. */
export function createServer(vault: Vault, opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'brain', version: '1.0.0' });
  registerReadTools(server, vault, opts.runRegex ?? workerSearch(new URL('./searchWorker.mjs', import.meta.url)));
  registerWriteTools(server, vault);
  registerImportTools(server, vault, opts.fetch);
  return server;
}

async function main() {
  const vault = await Vault.open(vaultPath());
  await createServer(vault).connect(new StdioServerTransport());
}

// Real paths on both sides: macOS reaches /var through /private/var, and a repo can sit behind a symlink.
const isMain = () => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
// A bad BRAIN_VAULT, an unreadable journal or a permission error: one line on stderr, not a stack trace.
if (isMain())
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
