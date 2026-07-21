import {
  AUTOMATION_DEBOUNCE_MS,
  AUTOMATION_DIGEST_MAX_CHARS,
  AUTOMATION_MAX_PROPOSALS,
  NOTIFICATION_IDS,
} from '../constants';
import { getLocal, getSession, getSettings, setLocal, setSession } from '../storage';
import type { AssistantAutomation } from '../types';
import { inQuietHours } from '../week';
import { buildPlanSchema, parseJsonObject, type PlannedStep } from './assistant';
import { appendTurn, newTurn, type AssistantProvider } from './assistantTypes';
import { gatherDataContext } from './context';
import { buildSkillBlock, loadSkills, selectSkills } from './skills';
import { getActiveTools } from './connector';
import { validateToolCall, type Tool } from './tools';
import { stripEmoji } from './tts';

/**
 * Automation engine: a scheduled agent run gathers the data snapshot, does
 * the discovery/triage described by the automation's prompt, and leaves a
 * digest in the assistant chat — with up to AUTOMATION_MAX_PROPOSALS
 * proposed actions attached as a pending-confirm plan (the existing confirm
 * UI + the SW's atomic apply handle the rest). Mutating actions NEVER
 * auto-run.
 *
 * Runs on cloud Gemini from the service worker (fetch works there); with no
 * API key the run queues in session and drains on-device on the next
 * dashboard open (the maybeGenerateBriefing pattern) — Nano runs are
 * digest-only because the merged proposal schema exceeds its constraint.
 */

export function buildAutomationSystem(context: string, skillBlock: string): string {
  return (
    'You are a scheduled background agent inside an ADHD-friendly productivity extension. ' +
    'Do the task described by the user prompt against their data snapshot. Reply with a blunt, ' +
    'concrete digest (2-4 short sentences, no greetings, no filler, no emoji) of what you found. ' +
    `Where an action would clearly help, propose up to ${AUTOMATION_MAX_PROPOSALS} tool calls — ` +
    'the user confirms them later; never propose actions the data does not support. Never invent data.' +
    skillBlock +
    '\n\nData snapshot:\n' +
    context
  );
}

/** digest + optional proposals; proposals reuse the plan schema's step items */
export function buildAutomationSchema(tools: readonly Tool[], withProposals: boolean): object {
  const digest = {
    type: 'string',
    description: 'Blunt 2-4 sentence digest of what the run found',
  };
  if (!withProposals) {
    return {
      type: 'object',
      required: ['digest'],
      additionalProperties: false,
      properties: { digest },
    };
  }
  const planSchema = buildPlanSchema(tools) as {
    properties: { steps: { items: object } };
  };
  return {
    type: 'object',
    required: ['digest'],
    additionalProperties: false,
    properties: {
      digest,
      proposals: {
        type: 'array',
        maxItems: AUTOMATION_MAX_PROPOSALS,
        items: planSchema.properties.steps.items,
      },
    },
  };
}

/** Parse a run reply; invalid proposals are discarded, never fatal */
export function parseAutomationReply(
  raw: string,
  tools: readonly Tool[],
): { digest: string; steps: PlannedStep[] } {
  const obj = parseJsonObject(raw);
  const digest = stripEmoji(String(obj.digest ?? '').trim()).slice(0, AUTOMATION_DIGEST_MAX_CHARS);
  if (!digest) throw new Error('empty digest');

  const steps: PlannedStep[] = [];
  const proposals = Array.isArray(obj.proposals) ? obj.proposals : [];
  for (const rawStep of proposals.slice(0, AUTOMATION_MAX_PROPOSALS)) {
    const name = (rawStep as { tool?: unknown })?.tool;
    const tool = typeof name === 'string' ? tools.find((t) => t.name === name) : undefined;
    if (!tool) continue;
    const valid = validateToolCall(tool, (rawStep as { params?: unknown }).params ?? {});
    if (!valid.ok) continue;
    steps.push({ name: tool.name, params: valid.params, summary: tool.summary(valid.params) });
  }
  return { digest, steps };
}

async function patchAutomation(id: string, patch: Partial<AssistantAutomation>): Promise<void> {
  const { assistantAutomations } = await getLocal('assistantAutomations');
  await setLocal({
    assistantAutomations: assistantAutomations.map((a) => (a.id === id ? { ...a, ...patch } : a)),
  });
}

/** Digest (and proposals, if any) land in the assistant chat like monitor nudges */
async function appendDigestTurn(
  digest: string,
  steps: PlannedStep[],
  source: 'nano' | 'cloud',
): Promise<void> {
  const { assistantThread } = await getSession('assistantThread');
  const turn =
    steps.length > 0
      ? newTurn('assistant', digest, {
          source,
          plan: {
            steps: steps.map((s) => ({ ...s, status: 'pending' as const })),
            status: 'pending-confirm',
          },
        })
      : newTurn('assistant', digest, { source });
  await setSession({ assistantThread: appendTurn(assistantThread, turn) });
}

export async function executeAutomation(
  automation: AssistantAutomation,
  provider: AssistantProvider,
  opts: { force?: boolean } = {},
  now = new Date(),
): Promise<{ ok: boolean; error?: string }> {
  const settings = await getSettings();
  if (!settings.assistantEnabled) return { ok: false, error: 'assistant disabled' };
  if (!opts.force && inQuietHours(settings.monitorQuietStart, settings.monitorQuietEnd, now)) {
    return { ok: false, error: 'quiet hours' };
  }
  // Debounce: an alarm and a pending-queue drain racing the same automation
  if (!opts.force && now.getTime() - automation.lastRunAt < AUTOMATION_DEBOUNCE_MS) {
    return { ok: false, error: 'ran moments ago' };
  }

  try {
    const [tools, context, skills] = await Promise.all([
      getActiveTools(),
      gatherDataContext(),
      loadSkills(),
    ]);
    const skillBlock = buildSkillBlock(selectSkills(automation.prompt, null, skills));
    // Nano can't hold the merged proposal schema — on-device runs are digest-only
    const withProposals = provider.id !== 'nano';
    const reply = await provider.generate({
      system: buildAutomationSystem(context, skillBlock),
      turns: [newTurn('user', automation.prompt)],
      responseSchema: buildAutomationSchema(tools, withProposals),
    });
    const { digest, steps } = parseAutomationReply(reply.text, tools);

    await appendDigestTurn(digest, steps, withProposals ? 'cloud' : 'nano');
    if (settings.notificationsEnabled && typeof chrome !== 'undefined' && chrome.notifications) {
      chrome.notifications.create(NOTIFICATION_IDS.automationPrefix + automation.id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
        title: `Jarvis: ${automation.name}`,
        message: steps.length > 0 ? `${digest}\n${steps.length} proposed action${steps.length === 1 ? '' : 's'} to confirm.` : digest,
        priority: 0,
      });
    }
    await patchAutomation(automation.id, {
      lastRunAt: now.getTime(),
      lastDigest: digest,
      lastError: '',
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await patchAutomation(automation.id, { lastRunAt: now.getTime(), lastError: message });
    return { ok: false, error: message };
  }
}

/**
 * Drain automations queued while no cloud key was available. Call from the
 * dashboard mount (page context — the Nano rule). Digest-only runs.
 */
export async function runPendingAutomations(provider: AssistantProvider): Promise<void> {
  const { pendingAutomationRuns } = await getSession('pendingAutomationRuns');
  if (pendingAutomationRuns.length === 0) return;
  if (!(await provider.available())) return;
  await setSession({ pendingAutomationRuns: [] });

  const { assistantAutomations } = await getLocal('assistantAutomations');
  for (const id of pendingAutomationRuns) {
    const automation = assistantAutomations.find((a) => a.id === id);
    if (automation?.enabled) {
      await executeAutomation(automation, provider).catch(() => undefined);
    }
  }
}
