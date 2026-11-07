// Agentic eval for the YouTube side panel's Gemini behaviour: notes shaped to
// the video (live, public videos) and Talk it through's ask-never-tell on a
// video. The exact production requests come from
// rust/core/examples/eval_requests.rs. Code graders always; the frozen Opus
// judge for Talk only when ANTHROPIC_API_KEY is set.
//
//   GEMINI_API_KEY=... npm run eval:youtube -- [--notes-trials 1] [--talk-trials 5] [--k 3]
//
// Notes trials spend YouTube quota (free tier: 8 hours of video a day; the
// three videos are about 2.3 hours). Writes eval/out/youtube-<time>.json.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JUDGE_VERSION, TALK_RUBRIC, TALK_SCHEMA, gradeNotes, gradeTalk, passHatK } from '../sidebar/graders.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const NOTES_TRIALS = arg('notes-trials', 1);
const TALK_TRIALS = arg('talk-trials', 5);
const K = arg('k', 3);
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) throw new Error('Set GEMINI_API_KEY.');
const MODEL = 'gemini-3.6-flash';

const spec = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'));
const requests = [
  ...spec.notes_tasks.map((t) => ({ id: t.id, kind: 'notes', url: t.url })),
  ...spec.talk.turns.map((t) => ({ id: t.id, kind: 'video-talk', title: spec.talk.title, sections: [spec.talk.notes], at: spec.talk.at, history: t.history })),
];
const built = new Map(
  JSON.parse(
    execFileSync('cargo', ['run', '-q', '-p', 'reader-core', '--example', 'eval_requests'], {
      cwd: join(root, 'rust'),
      input: JSON.stringify(requests),
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    }),
  ).map((b) => [b.id, b.body]),
);

let tokens = 0;
async function gemini(body) {
  const t0 = Date.now();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify(body),
  });
  const d = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${d.error?.message ?? ''}`.slice(0, 200));
  tokens += d.usageMetadata?.totalTokenCount ?? 0;
  const text = d.candidates?.[0]?.content?.parts?.filter((p) => p.text && !p.thought).map((p) => p.text).join('') ?? '';
  return { text, ms: Date.now() - t0 };
}

async function judgeTalk(turn, reply) {
  if (!process.env.ANTHROPIC_API_KEY) return { pass: true, why: 'no judge (ANTHROPIC_API_KEY unset): code graders only', raw: null };
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    system: TALK_RUBRIC,
    output_config: { format: { type: 'json_schema', schema: TALK_SCHEMA } },
    messages: [{ role: 'user', content: `Notes the learner is watching:\n${spec.talk.notes}\n\nThe learner's last line: ${turn.history.at(-1)?.text ?? '(conversation opening)'}\n\nThe reply to grade:\n${reply}` }],
  });
  const v = JSON.parse(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  return { pass: !v.tells, why: v.reason, raw: v };
}

const results = [];
const report = (id, trials) => {
  if (!trials.length) return;
  const c = trials.filter((t) => t.pass).length;
  const n = trials.length;
  results.push({ id, n, c, pass1: c / n, passHatK: n >= K ? passHatK(n, c, K) : null, trials });
  const fail = trials.find((t) => !t.pass);
  console.log(`${id.padEnd(22)} ${c}/${n}${n >= K ? `  pass^${K} ${passHatK(n, c, K).toFixed(2)}` : ''}  ~${Math.round(trials.reduce((s, t) => s + t.ms, 0) / n / 1000)} s${fail ? `  e.g. ${fail.why.slice(0, 100)}` : ''}`);
};

for (const task of spec.notes_tasks) {
  const trials = [];
  for (let i = 0; i < NOTES_TRIALS; i++) {
    try {
      const { text, ms } = await gemini(built.get(task.id));
      const notes = JSON.parse(text);
      const g = gradeNotes(notes, task);
      trials.push({ ...g, ms, notes });
    } catch (e) {
      trials.push({ pass: false, why: String(e.message ?? e), ms: 0 });
    }
  }
  report(task.id, trials);
}
for (const turn of spec.talk.turns) {
  const trials = [];
  for (let i = 0; i < TALK_TRIALS; i++) {
    try {
      const { text, ms } = await gemini(built.get(turn.id));
      const code = gradeTalk(text);
      const judge = code.pass ? await judgeTalk(turn, text) : { pass: false, why: '' };
      trials.push({ pass: code.pass && judge.pass, why: code.pass ? judge.why : `code: ${code.why}`, ms, reply: text });
    } catch (e) {
      trials.push({ pass: false, why: String(e.message ?? e), ms: 0 });
    }
  }
  report(turn.id, trials);
}

const summary = {
  tasksVersion: spec.version,
  model: MODEL,
  judge: process.env.ANTHROPIC_API_KEY ? `claude-opus-5-5 / ${JUDGE_VERSION}` : 'code graders only',
  meanPass1: results.reduce((s, r) => s + r.pass1, 0) / results.length,
  geminiTokens: tokens,
};
console.log(summary);
mkdirSync(join(root, 'eval', 'out'), { recursive: true });
const out = join(root, 'eval', 'out', `youtube-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify({ summary, results }, null, 2));
console.log(`wrote ${out}`);
