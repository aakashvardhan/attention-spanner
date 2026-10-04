import { LAYA_BIG_STEP_MIN, LAYA_FEELING_MIN } from './constants';
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

/**
 * Why a step fails the rule half of the self-check, or null when it passes.
 * ponytail: "and" is a word heuristic, so "list pros and cons" reads as two
 * actions. A false hit only costs one retry; parse a verb if that gets noisy.
 */
export function stepProblem(step: string, dump: Dump): string | null {
  if (dump.done?.some((d) => normal(d) === normal(step))) return 'already done';
  // A comma between digits is a thousands separator ($1,200), not a join.
  if (/\b(?:and|then)\b|;|,(?!\d)/i.test(step)) return 'two actions joined';
  if (step.split(/\s+/).length > 15) return 'too long';
  return null;
}

/** The ask again, with every rejected try and its reason, so the model does not repeat one. */
export function retryPrompt(dump: Dump, rejected: readonly { step: string; why: string }[]): string {
  if (!rejected.length) return nextStepPrompt(dump);
  const list = rejected.map((r) => `- ${r.step} (${r.why})`).join('\n');
  return `${nextStepPrompt(dump)}\n\nRejected, do not reply with these:\n${list}`;
}

export function nextStepPrompt(dump: Dump): string {
  if (!dump.done?.length) return dump.text;
  return `${dump.text}\n\nAlready done:\n${dump.done.map((s) => `- ${s}`).join('\n')}`;
}

/** Ticks off the current step; the next one is left unasked. */
export function completeStep(list: readonly Dump[], id: string): Dump[] {
  return list.map((d) =>
    d.id === id && d.nextStep ? { ...d, done: [...(d.done ?? []), d.nextStep], nextStep: undefined } : d,
  );
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
    .replace(/^[*_"'“]+|[*_"'”]+$/g, '')
    .trim();
  if (!step || /^none\b/i.test(step) || !/[\p{L}\p{N}]/u.test(step)) return null;
  return (step[0].toUpperCase() + step.slice(1)).slice(0, MAX_STEP_CHARS);
}
