import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { reportsDir, vaultPath } from '../args';

export interface BaselineInputs {
  usage?: { pages: number; visits: number };
  links?: { pages: number; connected: number; share: number };
  recall?: { tool: string; date: string; n: number; successRate: number; medianMs: number | null };
  cards?: { groups: number; cards: number };
  exportPath?: string;
}

const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;

export function baselineMarkdown(i: BaselineInputs): string {
  const row = (name: string, value: string | undefined) => `| ${name} | ${value ?? 'not run yet'} |`;
  return [
    '# Baseline',
    '',
    'Taken in Notion before any code (spec, Outcomes). Plans 2 and 3 compare against these numbers.',
    '',
    '| Measure | Result |',
    '|---|---|',
    row('Usage', i.usage && `${i.usage.visits} visits to ${i.usage.pages} Notion pages in Chrome history`),
    row('Connections (Notion)', i.links && `${i.links.connected} of ${i.links.pages} pages link both ways (${pct(i.links.share, 1)})`),
    row(
      'Fast recall (Notion)',
      i.recall && `${pct(i.recall.successRate)} found, median ${i.recall.medianMs === null ? '-' : (i.recall.medianMs / 1000).toFixed(1) + ' s'} (${i.recall.n} questions, ${i.recall.date})`,
    ),
    row('Card sort', i.cards && `${i.cards.cards} cards in ${i.cards.groups} groups`),
    row('Notion export (fidelity reference)', i.exportPath),
    '',
  ].join('\n');
}

const json = async <T>(path: string): Promise<T | undefined> => readFile(path, 'utf8').then((s) => JSON.parse(s) as T, () => undefined);

export async function baseline(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { vault: { type: 'string' }, export: { type: 'string' } } });
  const reports = await reportsDir(vaultPath(values.vault));
  const usage = await json<{ pages: Record<string, { visits: number }> }>(join(reports, 'baseline-usage.json'));
  const recalls = await json<NonNullable<BaselineInputs['recall']>[]>(join(reports, 'recall-summary.json'));
  const sort = await json<{ groups: { cards: string[] }[] }>(join(reports, 'card-sort.json'));
  const md = baselineMarkdown({
    usage: usage && { pages: Object.keys(usage.pages).length, visits: Object.values(usage.pages).reduce((a, p) => a + p.visits, 0) },
    links: await json(join(reports, 'baseline-links.json')),
    recall: recalls?.filter((r) => r.tool === 'notion').at(-1),
    cards: sort && { groups: sort.groups.length, cards: sort.groups.reduce((a, g) => a + g.cards.length, 0) },
    exportPath: values.export,
  });
  await writeFile(join(reports, 'baseline.md'), md);
  console.log(md);
}
