import { LAYA_BIG_STEP_MIN, LAYA_FEELING_MIN, LAYA_RECURRING_MIN } from './constants';
import { localDate } from './format';
import { confident, type LayaAnswer, type LayaQuestion } from './llm/laya';
import { OllamaError } from './llm/ollama';
import type { Dump } from './types';

/**
 * The brain dump: get a loop out of your head and park it. Parked dumps stay
 * out of sight on the new tab until you choose to open them. That is the point:
 * a list of open loops on screen restarts the rumination it was meant to stop.
 * Notes and tasks still live in Notion; this is not a notebook.
 */

export const MAX_DUMP_CHARS = 4000;
const MAX_STEP_CHARS = 200;

/**
 * The local model's one job, asked again after every step you tick off, so a
 * loop closes one small piece at a time. Ollama only: a dump never goes to
 * the cloud. The "one verb, one object" and "never join" lines are measured:
 * without them qwen3:8b joined two actions in 6 of 15 replies, with them 1.
 */
export const NEXT_STEP_SYSTEM =
  'Read this brain dump. Reply with the single first action to take: one verb, one object, under 10 minutes, ' +
  'one imperative sentence under 12 words. If the dump holds several tasks, pick only one; ' +
  'the others come later, one at a time. Never join two actions with "and", "then" or a comma. ' +
  'If steps are already done, give the next one and never repeat them. ' +
  'If nothing in it is actionable, or the done steps finish it, reply exactly NONE. ' +
  'No advice, no reassurance, no list.';

/**
 * A recurring dump is a practice, not a project: "get better at leetcode" has
 * no last step, so it gets one session a day, each about 1% further than the
 * day before, instead of a list it counts through until NONE.
 */
export const DAILY_STEP_SYSTEM =
  'This brain dump is an ongoing practice with no end. Reply with what to practise today: ' +
  'ONE focused 15 to 30 minute session, as one imperative sentence under 15 words that starts with a verb. ' +
  'Make it about 1% harder, deeper or broader than the last day, never a repeat. ' +
  'Name the exact skill, pattern or technique. Say what to do, not why. ' +
  'Never count through a list: no "the next problem", no "problem 4", no "the fourth one". ' +
  'No advice, no reassurance, no list.';

export function systemFor(dump: Dump): string {
  return dump.kind === 'recurring' ? DAILY_STEP_SYSTEM : NEXT_STEP_SYSTEM;
}

/** Asked once per dump, batched with the feeling question when both are due. */
export const RECURRING_QUESTION: LayaQuestion = {
  type: 'choice',
  instructions: 'Is this something to finish once, or a skill or habit to keep getting better at over time?',
  criteria: ['finish once', 'keep getting better'],
};

export function isRecurring(answer: LayaAnswer | undefined): boolean {
  if (answer?.type !== 'choice') return false;
  const p = (answer.probabilities as Record<string, unknown> | undefined)?.['keep getting better'];
  return typeof p === 'number' && p >= LAYA_RECURRING_MIN;
}

/** Days a recurring prompt carries; the model needs the trend, not the whole history. */
const DAYS_SHOWN = 7;

/**
 * Laya screens a fresh dump before the chat model is asked: a pure feeling
 * gets "nothing to act on" in ~150ms, not a made-up errand. It is not asked
 * whether a loop is finished; it said 0.88 with a task still open and 0.09
 * after the only task was done, so the chat model's NONE decides that.
 */
export const FEELING_QUESTION = {
  type: 'noul',
  instructions: 'Is this brain dump only a feeling or a vent, with no task in it?',
} as const;

export function isOnlyFeeling(answer: LayaAnswer | undefined): boolean {
  return confident(answer, LAYA_FEELING_MIN) === true;
}

/**
 * The self-check's size question. A choice, not a noul: asked "will this take
 * more than 10 minutes?" Laya gave every step ≤0.27, big or small. As a choice,
 * the small steps stayed ≤0.29 and half the big ones ("Finish the thesis draft",
 * "Learn React") came back 0.48–0.69; the other half look small to it.
 */
export const STEP_SIZE_QUESTION: LayaQuestion = {
  type: 'choice',
  instructions: 'How long does this step take a person to finish?',
  criteria: ['a few minutes', 'hours or days'],
};

/**
 * P("hours or days"), or null when the answer is missing or not what Laya
 * promises. It comes off the wire from a sidecar, so a bad shape must make the
 * size check pass quietly, not throw and lose the step.
 */
export function hoursShare(answer: LayaAnswer | undefined): number | null {
  if (answer?.type !== 'choice') return null;
  const p = (answer.probabilities as Record<string, unknown> | undefined)?.['hours or days'];
  return typeof p === 'number' && Number.isFinite(p) ? p : null;
}

export function isTooBig(answer: LayaAnswer | undefined): boolean {
  return (hoursShare(answer) ?? 0) >= LAYA_BIG_STEP_MIN;
}

/** Tries per step before the last one is kept anyway; a check never leaves you with no step. */
export const MAX_STEP_TRIES = 3;

/**
 * One model call's limit. With thinking off a step takes under a second and a
 * cold load ~2.4 s; qwen3 with thinking on was seen thinking for over 5 min.
 */
export const ASK_TIMEOUT_MS = 60_000;

/** What to tell you when an ask fails. Ollama's and Claude's own messages are already written for people. */
export function askErrorMessage(err: unknown, who: 'Ollama' | 'Claude', timedOut: boolean): string {
  const tail = ' The dump is still parked.';
  if (timedOut) return `${who} took longer than ${ASK_TIMEOUT_MS / 1000} s.${tail}`;
  if (err instanceof OllamaError && err.kind === 'forbidden') {
    return `Ollama refused this extension; Settings → Local AI shows the fix.${tail}`;
  }
  // A TypeError or ReferenceError is a bug here, not something to show you.
  const readable =
    err instanceof OllamaError ||
    (who === 'Claude' && err instanceof Error && !(err instanceof TypeError || err instanceof ReferenceError));
  if (readable && err.message) return `${err.message.slice(0, 160)}${tail}`;
  return `${who} didn't answer.${tail}`;
}

const normal = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();

const FILLER = new Set([
  'the',
  'a',
  'an',
  'on',
  'in',
  'of',
  'to',
  'for',
  'and',
  'with',
  'from',
  'your',
  'my',
  'this',
  'that',
  'list',
  'top',
]);

/** What a step is about: its words minus the leading verb and filler, so "Work on" and "Solve" match. */
function topic(step: string): Set<string> {
  const words = normal(step).split(/\s+/).filter(Boolean).slice(1);
  return new Set(words.filter((w) => !FILLER.has(w)));
}

/**
 * Same topic as an earlier step: 70% of the words shared. Tuned on the cases
 * that matter: "Work on / Solve the third problem" is a repeat (1.0); "3 sets
 * of push-ups" and "3 sets of squats" are not (0.6).
 */
function sameTopic(a: string, b: string): boolean {
  const x = topic(a);
  const y = topic(b);
  if (!x.size || !y.size) return normal(a) === normal(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared) >= 0.7;
}

/**
 * "The fourth problem", "problem 4", "the next exercise": counting, not getting better.
 * ponytail: a LeetCode id ("problem 217") reads as counting too, which costs one retry;
 * tell ids from positions if that starts eating tries.
 */
const COUNTING =
  /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|next|\d+(?:st|nd|rd|th))\b[^.]*\b(?:problem|question|item|exercise|lesson|chapter|card|one)s?\b|\b(?:problem|question|item|exercise|lesson|chapter)s?\s*#?\d+/i;

/**
 * Why a step fails the rule half of the self-check, or null when it passes.
 * ponytail: "and" is a word heuristic, so "list pros and cons" reads as two
 * actions. A false hit only costs one retry; parse a verb if that gets noisy.
 */
export function stepProblem(step: string, dump: Dump): string | null {
  if (dump.done?.some((d) => sameTopic(d, step))) return 'already done';
  if (dump.kind === 'recurring' && COUNTING.test(step)) return 'counting through a list';
  // A comma between digits is a thousands separator ($1,200), not a join.
  // A practice session may cover a few related things ("-ar, -er and -ir verbs"); a task step is one action.
  if (dump.kind !== 'recurring' && /\b(?:and|then)\b|;|,(?!\d)/i.test(step)) return 'two actions joined';
  if (step.split(/\s+/).length > (dump.kind === 'recurring' ? 20 : 15)) return 'too long';
  return null;
}

/** The ask again, with every rejected try and its reason, so the model does not repeat one. */
export function retryPrompt(dump: Dump, rejected: readonly { step: string; why: string }[]): string {
  if (!rejected.length) return nextStepPrompt(dump);
  const list = rejected.map((r) => `- ${r.step} (${r.why})`).join('\n');
  // Told only "not that", a model anchored on a list moves to the next position; say what to name instead.
  const hint = rejected.some((r) => r.why === 'counting through a list')
    ? '\nName a skill or pattern to practise, not a position in a list.'
    : '';
  return `${nextStepPrompt(dump)}\n\nRejected, do not reply with these:\n${list}${hint}`;
}

/**
 * The step to keep when every try failed the check. Never a repeat or a count:
 * showing one again is the loop this check exists to break.
 */
export function keepAfterRetries(rejected: readonly { step: string; why: string }[]): string | null {
  const unusable = new Set(['already done', 'counting through a list', 'a practice has no end', 'gave up']);
  const usable = rejected.filter((r) => !unusable.has(r.why));
  return usable.at(-1)?.step ?? null;
}

export function nextStepPrompt(dump: Dump): string {
  if (dump.kind === 'recurring') {
    const done = dump.done ?? [];
    // Counting days are left out: shown "the third problem", the model goes on to the fourth.
    const days = done
      .map((step, i) => ({ step, day: i + 1 }))
      .filter(({ step }) => !COUNTING.test(step))
      .slice(-DAYS_SHOWN)
      .map(({ step, day }) => `- Day ${day}: ${step}`)
      .join('\n');
    return `${dump.text}\n\n${days ? `Days so far, oldest first:\n${days}\n\n` : ''}This is day ${done.length + 1}.`;
  }
  if (!dump.done?.length) return dump.text;
  return `${dump.text}\n\nAlready done:\n${dump.done.map((s) => `- ${s}`).join('\n')}`;
}

/** Ticks off the current step; the next one is left unasked. */
export function completeStep(list: readonly Dump[], id: string, now = Date.now()): Dump[] {
  return list.map((d) =>
    d.id === id && d.nextStep
      ? { ...d, done: [...(d.done ?? []), d.nextStep], nextStep: undefined, lastDoneAt: now }
      : d,
  );
}

export function setKind(list: readonly Dump[], id: string, kind: Dump['kind']): Dump[] {
  return list.map((d) => (d.id === id ? { ...d, kind } : d));
}

/** Today's step of a recurring dump is ticked off; the next comes tomorrow. */
export function doneToday(dump: Dump, now: number): boolean {
  return dump.lastDoneAt !== undefined && localDate(new Date(dump.lastDoneAt)) === localDate(new Date(now));
}

/** A recurring dump that is still open and has not had today's step done. */
export function isDue(dump: Dump, now: number): boolean {
  return dump.kind === 'recurring' && dump.nextStep !== null && !doneToday(dump, now);
}

export function parkDump(list: readonly Dump[], text: string, now: number): Dump[] {
  const trimmed = text.trim().slice(0, MAX_DUMP_CHARS);
  if (!trimmed) return [...list];
  return [{ id: crypto.randomUUID(), text: trimmed, createdAt: now }, ...list];
}

export function removeDump(list: readonly Dump[], id: string): Dump[] {
  return list.filter((d) => d.id !== id);
}

export function setNextStep(list: readonly Dump[], id: string, step: string | null): Dump[] {
  return list.map((d) => (d.id === id ? { ...d, nextStep: step } : d));
}

/**
 * First line of the reply, unwrapped; null when the model said NONE (even with
 * an explanation after it) or nothing. A thinking block that leaked into the
 * content, as older Ollama builds do with qwen3, is dropped first.
 */
export function parseNextStep(reply: string): string | null {
  const line = reply
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const step = line
    .replace(/^(?:[-*•]|\d+[.)])(?:\s+|$)/, '')
    .replace(/^next step:\s*/i, '')
    // The daily prompt says "This is day N"; the model likes to echo it back as an opener.
    .replace(/^(?:(?:today(?:'s session)?|day \d+)\s*[,:.—-]?\s*)+/i, '')
    .replace(/^[*_"'“]+|[*_"'”]+$/g, '')
    .trim();
  if (!step || /^none\b/i.test(step) || !/[\p{L}\p{N}]/u.test(step)) return null;
  return (step[0].toUpperCase() + step.slice(1)).slice(0, MAX_STEP_CHARS);
}

export interface TraceStage {
  /** Laya, Check, or the model that wrote the step (it stands in for Ollama or Claude) */
  name: string;
  state: 'done' | 'active' | 'skip' | 'fail';
  /** Steps this stage wrote; above 1 means the self-check sent one back */
  tries: number;
}

/**
 * The trace as a row of chips: one per stage, in the order they first ran,
 * each in the state of its latest line. Reads the lines BrainDump writes, so
 * a change to their wording shows up here as a test failure.
 */
export function traceStages(lines: readonly string[]): TraceStage[] {
  const stages: TraceStage[] = [];
  for (const line of lines) {
    const parts = line.split(' · ');
    const server = parts[0];
    const name = (server === 'Ollama' || server === 'Claude') && parts.length >= 3 ? parts[1] : server;
    let stage = stages.find((s) => s.name === name);
    if (!stage) stages.push((stage = { name, state: 'done', tries: 0 }));
    stage.state = lineState(line);
    if (/ · try \d+:/.test(line)) stage.tries++;
  }
  return stages;
}

function lineState(line: string): TraceStage['state'] {
  if (line.endsWith('…') || line.endsWith('asking again')) return 'active';
  // "Laya · off, Ollama alone", "Laya · not running, Claude alone": the stage stepped aside.
  if (/skipped|, \w+ alone$/.test(line)) return 'skip';
  if (/no answer$|failed|refused|not running$|not answering$|no new step/.test(line)) return 'fail';
  return 'done';
}
