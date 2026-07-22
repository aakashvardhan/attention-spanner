import { getSession, setSession } from '../storage';
import { appendTurn, newTurn, type AssistantTurn } from './assistantTypes';
import type { AssistantOutcome } from './assistant';

/**
 * Writing assistant turns to the shared session thread. Lives outside the chat
 * component because more than one surface runs turns: the visible chat in the
 * popup, and the headless wake-word drainer on the dashboard (WakeHandoff).
 */

/** Read-modify-write against the freshest session thread (avoids clobbering
 * a turn another surface appended while we were thinking). */
export async function persistTurn(turn: AssistantTurn): Promise<void> {
  const { assistantThread } = await getSession('assistantThread');
  await setSession({ assistantThread: appendTurn(assistantThread, turn) });
}

export async function patchTurn(id: string, patch: Partial<AssistantTurn>): Promise<void> {
  const { assistantThread } = await getSession('assistantThread');
  await setSession({
    assistantThread: assistantThread.map((t) =>
      t.id === id ? { ...t, ...patch, toolCall: patch.toolCall ?? t.toolCall } : t,
    ),
  });
}

/**
 * Turn one outcome into the thread turn(s) it implies, and hand the spoken
 * phrasing to `say`. Confirm outcomes land as pending turns — the chat UI
 * renders their chips; a headless caller simply leaves them waiting.
 */
export async function persistOutcome(
  outcome: AssistantOutcome,
  say: (phrase: string) => void,
): Promise<void> {
  if (outcome.kind === 'reply') {
    await persistTurn(newTurn('assistant', outcome.text, { source: outcome.source }));
    say(outcome.text);
    return;
  }
  if (outcome.kind === 'confirm') {
    await persistTurn(
      newTurn('assistant', outcome.summary, {
        source: 'nano',
        toolCall: { name: outcome.toolName, params: outcome.params, status: 'pending-confirm' },
      }),
    );
    say(`Should I ${outcome.summary}?`);
    return;
  }
  if (outcome.kind === 'confirm-plan') {
    await persistTurn(
      newTurn('assistant', `That's ${outcome.steps.length} steps:`, {
        source: 'cloud',
        plan: {
          steps: outcome.steps.map((s) => ({ ...s, status: 'pending' as const })),
          status: 'pending-confirm',
        },
      }),
    );
    say(`Should I do these ${outcome.steps.length} things?`);
    return;
  }
  if (outcome.kind === 'done') {
    await persistTurn(newTurn('assistant', outcome.text, { kind: 'action-result', source: 'nano' }));
    say(outcome.text);
    return;
  }
  await persistTurn(newTurn('assistant', outcome.text, { kind: 'error', source: 'local' }));
}
