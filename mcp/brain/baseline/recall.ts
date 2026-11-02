import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ymd } from '../lib/daily';
import { reportsDir, terminal, vaultPath, type Io } from '../args';

export interface RecallRow { n: number; ms: number; success: boolean }
export const LIMIT_MS = 60_000;

export function parseQuestions(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^\s*(\d+)\.\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    if (Number(m[1]) !== out.length + 1) throw new Error(`question ${out.length + 1} is missing or out of order (found ${m[1]})`);
    out.push(m[2]);
  }
  if (out.length !== 25) throw new Error(`the benchmark needs exactly 25 questions; found ${out.length}`);
  return out;
}

/** A failure counts as the full minute, so giving up fast never looks better than finding it slowly. */
export function summarizeRecall(rows: RecallRow[]): { n: number; successRate: number; medianMs: number | null } {
  const t = rows.map((r) => (r.success ? Math.min(r.ms, LIMIT_MS) : LIMIT_MS)).sort((a, b) => a - b);
  const median = t.length ? (t.length % 2 ? t[(t.length - 1) / 2] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2) : null;
  return { n: rows.length, successRate: rows.length ? rows.filter((r) => r.success).length / rows.length : 0, medianMs: median };
}

export async function runRecall(questions: string[], tool: string, io: Io): Promise<RecallRow[]> {
  const rows: RecallRow[] = [];
  for (let i = 0; i < questions.length; i++) {
    io.say(`\nQuestion ${i + 1} of ${questions.length}: ${questions[i]}`);
    await io.ask('Press Enter to start the clock. ');
    const t0 = io.now();
    const a = (await io.ask(`Find it in ${tool}. Press Enter once the note is open, or type x to give up. `)).trim().toLowerCase();
    const ms = io.now() - t0;
    let success = false;
    if (a === 'x') io.say('Counted as not found.');
    else if (ms > LIMIT_MS) io.say('Over 60 s: counted as not found.');
    else success = (await io.ask('Is it the right note? (y/n) ')).trim().toLowerCase().startsWith('y');
    rows.push({ n: i + 1, ms, success });
  }
  return rows;
}

const TOOLS: Record<string, string> = { notion: 'Notion (its own search)', brain: 'the Brain page' };

/**
 * The questions are frozen on first use: a later edit is refused, so the import
 * cannot be tuned to them. Claude never opens recall-questions.md.
 */
export async function recall(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { vault: { type: 'string' }, tool: { type: 'string' } } });
  const tool = values.tool ?? '';
  if (!TOOLS[tool]) throw new Error(`--tool must be one of: ${Object.keys(TOOLS).join(', ')}`);
  const reports = await reportsDir(vaultPath(values.vault));
  const text = await readFile(join(reports, 'recall-questions.md'), 'utf8').catch(() => {
    throw new Error(`Write 25 numbered questions in ${join(reports, 'recall-questions.md')} first.`);
  });
  const questions = parseQuestions(text);
  const sha256 = createHash('sha256').update(text).digest('hex');
  const freezePath = join(reports, 'recall-freeze.json');
  const frozen = await readFile(freezePath, 'utf8').then((s) => JSON.parse(s) as { sha256: string }, () => null);
  if (frozen && frozen.sha256 !== sha256) throw new Error('recall-questions.md changed after it was frozen. Restore it; the benchmark only means something unchanged.');
  if (!frozen) await writeFile(freezePath, JSON.stringify({ sha256, frozenAt: new Date().toISOString(), count: questions.length }, null, 1));

  const io = terminal();
  try {
    const rows = await runRecall(questions, TOOLS[tool], io);
    const date = ymd(new Date());
    await writeFile(join(reports, `recall-${tool}-${date}.csv`), ['n,ms,success', ...rows.map((r) => `${r.n},${r.ms},${r.success}`)].join('\n') + '\n');
    const s = summarizeRecall(rows);
    const summaryPath = join(reports, 'recall-summary.json');
    const all = await readFile(summaryPath, 'utf8').then((x) => JSON.parse(x) as unknown[], () => []);
    await writeFile(summaryPath, JSON.stringify([...all, { tool, date, ...s }], null, 1));
    io.say(`\n${tool}: ${Math.round(s.successRate * 100)}% found, median ${s.medianMs === null ? '-' : (s.medianMs / 1000).toFixed(1) + ' s'}.`);
  } finally {
    io.close();
  }
}
