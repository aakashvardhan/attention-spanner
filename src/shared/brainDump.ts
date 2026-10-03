import type { Dump } from './types';

/**
 * The brain dump: get a loop out of your head and park it. Parked dumps stay
 * out of sight on the new tab until you choose to open them. That is the point:
 * a list of open loops on screen restarts the rumination it was meant to stop.
 * Notes and tasks still live in Notion; this is not a notebook.
 */

export const MAX_DUMP_CHARS = 4000;
const MAX_STEP_CHARS = 200;

/** The local model's one job. Ollama only: a dump never goes to the cloud. */
export const NEXT_STEP_SYSTEM =
  'Read this brain dump. Reply with ONE concrete action that takes under 10 minutes, ' +
  'as one imperative sentence under 15 words. If nothing in it is actionable, reply exactly NONE. ' +
  'No advice, no reassurance, no list.';

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

/** First line of the reply, unwrapped; null when the model said NONE or nothing. */
export function parseNextStep(reply: string): string | null {
  const line = reply
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const step = line
    .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
    .replace(/^next step:\s*/i, '')
    .replace(/^[*_"'“]+|[*_"'”]+$/g, '')
    .trim();
  if (!step || /^none\W*$/i.test(step)) return null;
  return step.slice(0, MAX_STEP_CHARS);
}
