/**
 * One entry for the brain's local tools: `node dist-mcp/cli.mjs <command> [flags]`.
 * Each command writes only under <vault>/.brain/reports/ (drive-probe also uses <vault>/.brain/probe/), or prints.
 */
import { cards } from './baseline/cards';
import { notionLinks } from './baseline/notionLinks';
import { recall } from './baseline/recall';
import { baseline } from './baseline/report';
import { treeTest } from './baseline/treeTest';
import { usage } from './baseline/usage';
import { diffObsidianCmd } from './diffObsidian';
import { driveProbe } from './platform/driveProbe';

const commands: Record<string, (argv: string[]) => Promise<void>> = {
  'diff-obsidian': diffObsidianCmd,
  'drive-probe': driveProbe,
  usage,
  'notion-links': notionLinks,
  cards,
  recall,
  'tree-test': treeTest,
  baseline,
};

const [name, ...argv] = process.argv.slice(2);
const run = name ? commands[name] : undefined;
if (!run) {
  console.error(`Usage: node dist-mcp/cli.mjs <${Object.keys(commands).join(' | ')}> [flags]`);
  process.exit(2);
}
run(argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
