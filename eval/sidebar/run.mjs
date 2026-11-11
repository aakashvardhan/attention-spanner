// Agentic eval for the side panel's Haiku behaviour (Listen narration and
// Talk it through's ask-never-tell). Frozen tasks (tasks.json), the exact
// production requests (built by rust/core/examples/eval_requests.rs), code
// graders plus a frozen model judge, n trials per task, pass@1 / pass^k and
// cost per successful task.
//
//   ANTHROPIC_API_KEY=... npm run eval:sidebar -- [--trials 5] [--k 3] [--min 0.9]
//
// Writes eval/out/sidebar-<timestamp>.json. Exits 1 if mean pass@1 < --min.
import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JUDGE_MODEL, JUDGE_VERSION, LISTEN_RUBRIC, LISTEN_SCHEMA, TALK_RUBRIC, TALK_SCHEMA,
  claudeCost, gradeListen, gradeTalk, judgeVerdict, passAtK, passHatK,
} from './graders.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const TRIALS = arg('trials', 5);
const K = arg('k', 3);
const MIN = arg('min', 0.9);

const spec = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'));
const tasks = spec.tasks.map((t) => ({ ...t, title: spec.title, sections: spec.sections }));
const built = JSON.parse(
  execFileSync('cargo', ['run', '-q', '-p', 'reader-core', '--example', 'eval_requests'], {
    cwd: join(root, 'rust'),
    input: JSON.stringify(tasks),
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  }),
);
const bodies = new Map(built.map((b) => [b.id, b.body]));
if (!built.length) throw new Error('tasks.json has no tasks.');

const client = new Anthropic();
let cost = 0;
const spend = (model, usage) => {
  cost += claudeCost(model, usage);
};
const text = (msg) => msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

async function systemUnderTest(task) {
  const { stream: _stream, ...body } = bodies.get(task.id);
  const msg = await client.messages.create(body);
  spend(body.model, msg.usage);
  return text(msg);
}

async function judge(task, reply) {
  const talk = task.kind === 'talk';
  const content = talk
    ? `Notes the learner is reading:\n${spec.sections.join('\n\n')}\n\nThe learner's last line: ${task.history.at(-1)?.text ?? '(conversation opening)'}\n\nThe reply to grade:\n${reply}`
    : `The section:\n${spec.sections[task.n - 1]}\n\nThe narration to grade:\n${reply}`;
  const msg = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 16000,
    system: talk ? TALK_RUBRIC : LISTEN_RUBRIC,
    output_config: { format: { type: 'json_schema', schema: talk ? TALK_SCHEMA : LISTEN_SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  spend(JUDGE_MODEL, msg.usage);
  const v = judgeVerdict(msg);
  if (!v) return { pass: false, why: `judge gave no verdict (${msg.stop_reason})`, raw: null };
  const pass = talk ? !v.tells : (task.math ? v.explains_math : true) && !v.symbol_by_symbol && !v.adds_content;
  return { pass, why: v.reason, raw: v };
}

async function trial(task) {
  const reply = await systemUnderTest(task);
  const code = task.kind === 'talk' ? gradeTalk(reply) : gradeListen(reply, task);
  // Skips are fully graded by code; everything else also goes to the judge.
  const model = code.pass && !task.skip ? await judge(task, reply) : { pass: code.pass, why: '', raw: null };
  return { reply, code, model, pass: code.pass && model.pass };
}

const results = [];
for (const task of tasks) {
  const trials = [];
  for (let i = 0; i < TRIALS; i++) trials.push(await trial(task));
  const c = trials.filter((t) => t.pass).length;
  results.push({ id: task.id, n: TRIALS, c, pass1: c / TRIALS, passAtK: passAtK(TRIALS, c, K), passHatK: passHatK(TRIALS, c, K), trials });
  const fails = trials.filter((t) => !t.pass).map((t) => (t.code.pass ? `judge: ${t.model.why}` : `code: ${t.code.why}`));
  console.log(`${task.id.padEnd(24)} ${c}/${TRIALS}  pass^${K} ${passHatK(TRIALS, c, K).toFixed(2)}${fails.length ? `  e.g. ${fails[0].slice(0, 110)}` : ''}`);
}

const mean = (f) => results.reduce((s, r) => s + f(r), 0) / results.length;
const successes = results.reduce((s, r) => s + r.c, 0);
const summary = {
  tasksVersion: spec.version,
  judge: `${JUDGE_MODEL} / ${JUDGE_VERSION}`,
  systemUnderTest: [...new Set(built.map((b) => b.model))].join(','),
  trialsPerTask: TRIALS,
  k: K,
  meanPass1: mean((r) => r.pass1),
  meanPassAtK: mean((r) => r.passAtK),
  meanPassHatK: mean((r) => r.passHatK),
  costUsd: cost,
  costPerSuccessUsd: successes ? cost / successes : null,
};
console.log(summary);
mkdirSync(join(root, 'eval', 'out'), { recursive: true });
const out = join(root, 'eval', 'out', `sidebar-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify({ summary, results }, null, 2));
console.log(`wrote ${out}`);
process.exit(summary.meanPass1 >= MIN ? 0 : 1);
