/**
 * One entry for the brain's local tools: `node dist-mcp/cli.mjs <command> [flags]`.
 * Each command writes only under <vault>/.brain/reports/, or prints.
 */
import { notionLinks } from './baseline/notionLinks';
import { usage } from './baseline/usage';

const commands: Record<string, (argv: string[]) => Promise<void>> = {
  usage,
  'notion-links': notionLinks,
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
