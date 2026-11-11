import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { QueryError } from '../lib/query';
import type { Vault } from '../vault';

export const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });
export const fail = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Hints Claude Code shows and permission rules can use (spec, Vault MCP server; taken from Gloss). */
export const READ = { readOnlyHint: true, openWorldHint: false };
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
export const IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const IDEMPOTENT_OPEN = { ...IDEMPOTENT, openWorldHint: true };

/**
 * Every call sees the vault as it is now, since the Brain page or Windows may have changed it; every failure is a message, never a crash.
 * Queued writes pass `refresh = false` (they re-read inside the queue), and so do the staging tools, which never read the index.
 */
export async function guard(vault: Vault, fn: () => Promise<CallToolResult>, refresh = true): Promise<CallToolResult> {
  try {
    if (refresh) await vault.refresh();
    return await fn();
  } catch (e) {
    if (e instanceof QueryError) return fail(`${e.message} at character ${e.pos + 1}`);
    return fail(e instanceof Error ? e.message : String(e));
  }
}
