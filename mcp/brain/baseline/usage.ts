import { copyFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { reportsDir, vaultPath } from '../args';
import { aggregateVisits, chromeTimeToMs, notionPageId } from './notion';
import { NOTION_DB, pageTitles, readNotion } from './notionDb';

const HISTORY = join(homedir(), 'Library/Application Support/Google/Chrome/Default/History');

/**
 * Visits per Notion page from Chrome's own history. Only page ids and counts
 * are kept: every URL, and every other site, is dropped before anything is
 * written. Run only after the user says yes (spec, Ground truth).
 */
export async function usage(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { vault: { type: 'string' }, history: { type: 'string' }, notion: { type: 'string' } } });
  const reports = await reportsDir(vaultPath(values.vault));
  // Chrome holds a lock on the live file, so read a copy.
  const copy = join(tmpdir(), `brain-history-${process.pid}.sqlite`);
  await copyFile(values.history ?? HISTORY, copy);
  let rows: { url: string; time: number | bigint }[];
  try {
    const db = new DatabaseSync(copy, { readOnly: true });
    const stmt = db.prepare("SELECT urls.url AS url, visits.visit_time AS time FROM visits JOIN urls ON urls.id = visits.url WHERE urls.url LIKE '%notion.%'");
    // Chrome's microseconds since 1601 pass Number.MAX_SAFE_INTEGER; read them as bigints, then round.
    stmt.setReadBigInts(true);
    rows = stmt.all() as unknown as { url: string; time: number | bigint }[];
    db.close();
  } finally {
    await rm(copy, { force: true });
  }
  const pages = aggregateVisits(rows.map((r) => ({ id: notionPageId(r.url), ms: chromeTimeToMs(Number(r.time)) })));
  await writeFile(join(reports, 'baseline-usage.json'), JSON.stringify({ generatedAt: new Date().toISOString(), pages }, null, 1));

  // A readable list for writing the recall questions: titles come from Notion's own cache.
  const titles = pageTitles(readNotion(values.notion ?? NOTION_DB).blocks);
  const top = Object.entries(pages).sort((a, b) => b[1].visits - a[1].visits).slice(0, 100);
  const md = [
    '# Most visited Notion pages',
    '',
    'From Chrome history. Use it to remember what you actually look things up for.',
    '',
    '| Visits | Last visit | Page |',
    '|---|---|---|',
    ...top.map(([id, p]) => `| ${p.visits} | ${p.lastVisit.slice(0, 10)} | ${titles.get(id) || '(not in the Notion cache)'} |`),
    '',
  ].join('\n');
  await writeFile(join(reports, 'baseline-usage.md'), md);
  console.log(`${Object.keys(pages).length} Notion pages, ${rows.length} visits. Wrote baseline-usage.json and baseline-usage.md to ${reports}`);
}
