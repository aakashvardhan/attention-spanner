import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { reportsDir, vaultPath } from '../args';
import { NOTION_DB, pageTitles, readNotion } from './notionDb';
import { parseGroups, stratifiedSample } from './sample';

// Never sampled, never imported (spec, Scope of import).
const NEVER = new Set(['account informations']);

/**
 * `cards` writes about 40 page titles for the user to group; `cards --read`
 * checks the grouping and saves it as card-sort.json for plan 2's area map.
 */
export async function cards(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { vault: { type: 'string' }, notion: { type: 'string' }, read: { type: 'boolean' }, n: { type: 'string' }, seed: { type: 'string' } } });
  const reports = await reportsDir(vaultPath(values.vault));
  const samplePath = join(reports, 'card-sort-sample.json');
  const sortPath = join(reports, 'card-sort.md');
  if (values.read) {
    const expected = JSON.parse(await readFile(samplePath, 'utf8')) as string[];
    const groups = parseGroups(await readFile(sortPath, 'utf8'), expected);
    await writeFile(join(reports, 'card-sort.json'), JSON.stringify({ readAt: new Date().toISOString(), groups }, null, 1));
    console.log(`${groups.length} groups, ${expected.length} cards. Saved card-sort.json.`);
    return;
  }
  const { blocks, collectionParents } = readNotion(values.notion ?? NOTION_DB);
  const titles = pageTitles(blocks);
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const parent = (id: string) => byId.get(id)?.parent_id ?? collectionParents.get(id) ?? null;
  // The stratum is the top-level page a page sits under: its area of the workspace.
  const top = (id: string) => {
    let cur = id;
    for (let i = 0; i < 500; i++) {
      const p = parent(cur);
      if (!p || !titles.has(p)) return cur;
      cur = p;
    }
    return cur;
  };
  const pages = [...titles].filter(([id, t]) => t.trim() && byId.get(id)?.alive && !NEVER.has(t.trim().toLowerCase()));
  const titleTaken = new Set<string>();
  const unique = pages.filter(([, t]) => !titleTaken.has(t) && titleTaken.add(t));
  const picked = stratifiedSample(unique, ([id]) => top(id), Number(values.n ?? 40), Number(values.seed ?? 1)).map(([, t]) => t);
  await writeFile(samplePath, JSON.stringify(picked, null, 1));
  await writeFile(
    sortPath,
    [
      '# Card sort',
      '',
      'Group these pages the way you think about them. Add a "## Group name" heading for each group, in your own words, and move every "- title" line under one heading. Use as many groups as you like. Leave nothing ungrouped.',
      '',
      'When done, run: node dist-mcp/cli.mjs cards --read',
      '',
      ...picked.map((t) => `- ${t}`),
      '',
    ].join('\n'),
  );
  console.log(`Wrote ${picked.length} cards to ${sortPath}`);
}
