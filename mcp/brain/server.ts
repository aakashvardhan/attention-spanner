import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { workerSearch, type SearchRunner } from './regexSearch';
import { registerReadTools } from './tools/read';
import { Vault } from './vault';

export interface ServerOptions { runRegex?: SearchRunner; fetch?: typeof fetch }

/** The vault MCP server (spec, Vault MCP server). Read tools need no approval; Claude Code asks before every write. */
export function createServer(vault: Vault, opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'brain', version: '1.0.0' });
  registerReadTools(server, vault, opts.runRegex ?? workerSearch(new URL('./searchWorker.mjs', import.meta.url)));
  return server;
}

async function main() {
  const root = process.env.BRAIN_VAULT;
  if (!root) {
    console.error('BRAIN_VAULT is not set: point it at the vault folder.');
    process.exit(1);
  }
  const vault = await Vault.open(root);
  await createServer(vault).connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
