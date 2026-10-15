import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ymd } from '../../../src/shared/brain/daily';
import { reportsDir, terminal, vaultPath, type Io } from '../args';

export interface TreeNode { name: string; children: TreeNode[] }
export interface TreeTask { text: string; answers: string[] }

export function parseTree(md: string): TreeNode {
  const root: TreeNode = { name: '', children: [] };
  const stack: { indent: number; node: TreeNode }[] = [{ indent: -1, node: root }];
  for (const line of md.split(/\r?\n/)) {
    const m = /^(\s*)[-*]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '  ').length;
    while (stack[stack.length - 1].indent >= indent) stack.pop();
    const node: TreeNode = { name: m[2].replace(/\/$/, ''), children: [] };
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
  }
  if (!root.children.length) throw new Error('the area map has no folders');
  return root;
}

export function parseTreeTasks(md: string): TreeTask[] {
  const out: TreeTask[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^\s*\d+\.\s+(.+?)\s*=>\s*(.+?)\s*$/.exec(line);
    if (m) out.push({ text: m[1], answers: m[2].split('|').map((a) => a.trim().replace(/^\/|\/$/g, '')) });
  }
  if (out.length !== 15) throw new Error(`the tree test needs exactly 15 tasks written "N. task => Folder/Sub"; found ${out.length}`);
  return out;
}

/** Folder names only, the way tree testing works: no search, no note titles. */
export async function runTreeTask(root: TreeNode, io: Io): Promise<{ path: string; backtracked: boolean }> {
  const trail: TreeNode[] = [root];
  let backtracked = false;
  for (;;) {
    const here = trail[trail.length - 1];
    const where = trail.slice(1).map((n) => n.name).join('/');
    io.say(`\n${where || '(top)'}`);
    here.children.forEach((c, i) => io.say(`  ${i + 1}. ${c.name}${c.children.length ? '/' : ''}`));
    const a = (await io.ask(`Number to open${where ? ', 0 to go up, h for "it is here"' : ''}: `)).trim().toLowerCase();
    if (a === 'h' && where) return { path: where, backtracked };
    if (a === '0' && where) {
      trail.pop();
      backtracked = true;
      continue;
    }
    const next = here.children[Number(a) - 1];
    if (next) trail.push(next);
  }
}

export function summarizeTree(rows: { success: boolean; direct: boolean }[]): { n: number; success: number; directness: number } {
  const n = rows.length;
  return { n, success: n ? rows.filter((r) => r.success).length / n : 0, directness: n ? rows.filter((r) => r.direct).length / n : 0 };
}

export async function treeTest(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { vault: { type: 'string' }, label: { type: 'string' } } });
  const label = values.label ?? 'map';
  const reports = await reportsDir(vaultPath(values.vault));
  const root = parseTree(await readFile(join(reports, 'area-map.md'), 'utf8'));
  const tasks = parseTreeTasks(await readFile(join(reports, 'tree-tasks.md'), 'utf8'));
  const io = terminal();
  try {
    const rows = [];
    for (const [i, t] of tasks.entries()) {
      io.say(`\nTask ${i + 1} of ${tasks.length}: ${t.text}`);
      const r = await runTreeTask(root, io);
      const success = t.answers.some((a) => a.toLowerCase() === r.path.toLowerCase());
      rows.push({ n: i + 1, path: r.path, success, direct: success && !r.backtracked });
    }
    const s = summarizeTree(rows);
    await writeFile(join(reports, `tree-test-${label}-${ymd(new Date())}.json`), JSON.stringify({ label, ...s, rows }, null, 1));
    io.say(`\nSuccess ${Math.round(s.success * 100)}% (target 80), directness ${Math.round(s.directness * 100)}% (target 70).`);
  } finally {
    io.close();
  }
}
