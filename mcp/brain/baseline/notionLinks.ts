import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { reportsDir, vaultPath } from '../args';
import { linkMeasure, toUuid } from './notion';
import { NOTION_DB, readNotion } from './notionDb';

const ids = (s?: string) => (s ? s.split(',').map((x) => toUuid(x.trim().replace(/-/g, ''))) : undefined);

/**
 * Notion's Connections baseline. With no --roots it covers every page in the
 * cache; rerun it with the in-scope roots once the area map exists (plan 2).
 */
export async function notionLinks(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { vault: { type: 'string' }, notion: { type: 'string' }, roots: { type: 'string' }, exclude: { type: 'string' } } });
  const { blocks, collectionParents } = await readNotion(values.notion ?? NOTION_DB);
  const scope = { roots: ids(values.roots), exclude: ids(values.exclude) };
  const m = linkMeasure(blocks, collectionParents, scope);
  const reports = await reportsDir(vaultPath(values.vault));
  await writeFile(join(reports, 'baseline-links.json'), JSON.stringify({ generatedAt: new Date().toISOString(), scope, ...m }, null, 1));
  console.log(`${m.connected} of ${m.pages} pages link both ways (${(m.share * 100).toFixed(1)}%).`);
}
