/**
 * What the MCP server may write (spec, Vault MCP server: Guards). Compared
 * ignoring case and Unicode form: macOS and Windows treat "Sources/" and
 * "sources/" as one folder.
 */
const BRAIN_DIRS = ['.brain/staging/', '.brain/journal/', '.brain/history/', '.brain/trash/', '.brain/import/'];
const BRAIN_FILES = ['.brain/mcp-log.jsonl', '.brain/starred.json'];

export function serverMayWrite(rel: string, promoting = false): boolean {
  const r = rel.normalize('NFC').toLowerCase();
  if (r === '.obsidian' || r.startsWith('.obsidian/')) return false;
  if (r.startsWith('sources/')) return promoting;
  if (r.startsWith('.brain/')) return BRAIN_DIRS.some((d) => r.startsWith(d)) || BRAIN_FILES.includes(r);
  return true;
}

/** Folders the index never reads (spec, File conventions): hidden ones, sources/ and attachments/. */
export function indexSkips(dir: string): boolean {
  const parts = dir.split('/');
  return parts.some((p) => p.startsWith('.')) || /^(sources|attachments)$/i.test(parts[0]);
}
