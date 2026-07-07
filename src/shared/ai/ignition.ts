import { createSession } from './brainDump';

/**
 * Ignition mode: rewrite a stuck task into ONE tiny concrete first action
 * doable in under two minutes — the ADHD task-initiation wall falls to
 * specificity, not willpower. Same on-device Gemini Nano rules as
 * brainDump.ts: runs in extension pages only, never the service worker.
 */

const IGNITION_TIMEOUT_MS = 20_000;
const MAX_TASK_CHARS = 300;
export const MAX_FIRST_ACTION_CHARS = 140;

const SYSTEM_PROMPT =
  'You help a person with ADHD start a task they are stuck on. ' +
  'Given the task, respond with "firstAction": ONE ultra-specific physical first step ' +
  'that takes under 2 minutes and starts the task — like opening the exact file, ' +
  'writing one rough sentence, or putting shoes by the door. ' +
  'Imperative voice, under 15 words, no advice, no lists. Respond with JSON only.';

const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['firstAction'],
  additionalProperties: false,
  properties: {
    firstAction: { type: 'string', maxLength: MAX_FIRST_ACTION_CHARS },
  },
};

/** Pure parser, unit-tested: tolerates code fences, validates, throws on junk */
export function parseIgnitionResult(raw: string): string {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error('Model returned invalid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Model returned non-object JSON');
  }

  const value = (parsed as Record<string, unknown>).firstAction;
  if (typeof value !== 'string') {
    throw new Error('Model returned no first action');
  }
  const action = value
    .replace(/^[-•*]\s*/, '')
    .replace(/^["'“]|["'”]$/g, '')
    .trim()
    .slice(0, MAX_FIRST_ACTION_CHARS);
  if (!action) {
    throw new Error('Model returned an empty first action');
  }
  return action;
}

export async function suggestFirstAction(taskText: string): Promise<string> {
  const input = taskText.trim().slice(0, MAX_TASK_CHARS);
  if (!input) throw new Error('Nothing to ignite');

  const session = await createSession(SYSTEM_PROMPT);
  try {
    const raw = await session.prompt(`Task: ${input}`, {
      responseConstraint: RESPONSE_SCHEMA,
      signal: AbortSignal.timeout(IGNITION_TIMEOUT_MS),
    });
    return parseIgnitionResult(raw);
  } finally {
    session.destroy();
  }
}
