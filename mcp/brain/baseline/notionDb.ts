import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { notionTitle } from './notion';

/** One row of Notion's local block cache, the columns the baseline needs. */
export interface NBlock { id: string; type: string; parent_id: string | null; properties: string | null; format: string | null; alive: number }

export const NOTION_DB = join(homedir(), 'Library/Application Support/Notion/notion.db');

/** Read-only: Notion keeps the file open, and nothing here may change it. */
export function readNotion(file = NOTION_DB): { blocks: NBlock[]; collectionParents: Map<string, string> } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('SELECT id, type, parent_id, properties, format, alive FROM block').all() as unknown as NBlock[];
    // The cache can hold one row per signed-in user; one per block is enough here.
    const blocks = [...new Map(rows.map((b) => [b.id, b])).values()];
    const collections = db.prepare('SELECT id, parent_id FROM collection').all() as unknown as { id: string; parent_id: string }[];
    return { blocks, collectionParents: new Map(collections.map((c) => [c.id, c.parent_id])) };
  } finally {
    db.close();
  }
}

export function pageTitles(blocks: NBlock[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of blocks) if (b.type === 'page' || b.type === 'collection_view_page') out.set(b.id, notionTitle(b.properties));
  return out;
}
