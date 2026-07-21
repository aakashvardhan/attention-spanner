import { executeAutomation } from '../shared/ai/automations';
import { geminiProvider } from '../shared/ai/geminiProvider';
import {
  AUTOMATION_MIN_INTERVAL_MINUTES,
  MAX_AUTOMATIONS,
} from '../shared/constants';
import { getLocal, getSession, setLocal, setSession } from '../shared/storage';
import type { AssistantAutomation, AutomationSchedule } from '../shared/types';

/**
 * Automation CRUD + the service-worker run path. All writes here (the
 * memory.ts/skills.ts rule); alarms re-arm via the storage-change listener
 * in index.ts. The LLM run itself uses cloud Gemini directly from the SW —
 * geminiProvider needs only fetch + settings, both SW-safe. No key: the run
 * queues in session and drains on-device on the next dashboard open.
 */

function cleanSchedule(schedule: AutomationSchedule): AutomationSchedule {
  if (schedule.kind === 'every') {
    return { kind: 'every', minutes: Math.max(schedule.minutes, AUTOMATION_MIN_INTERVAL_MINUTES) };
  }
  return /^\d{2}:\d{2}$/.test(schedule.time) ? schedule : { kind: 'daily', time: '08:00' };
}

export async function addAutomation(
  input: Pick<AssistantAutomation, 'name' | 'prompt' | 'schedule'>,
): Promise<{ ok: boolean; automation?: AssistantAutomation; error?: string }> {
  const name = input.name.trim().slice(0, 60);
  const prompt = input.prompt.trim().slice(0, 500);
  if (!name || !prompt) return { ok: false, error: 'An automation needs a name and a prompt.' };

  const { assistantAutomations } = await getLocal('assistantAutomations');
  if (assistantAutomations.length >= MAX_AUTOMATIONS) {
    return { ok: false, error: `Automation limit reached (${MAX_AUTOMATIONS}).` };
  }
  const now = Date.now();
  const automation: AssistantAutomation = {
    id: crypto.randomUUID(),
    name,
    prompt,
    schedule: cleanSchedule(input.schedule),
    enabled: true,
    createdAt: now,
    updatedAt: now,
    lastRunAt: 0,
    lastDigest: '',
    lastError: '',
  };
  await setLocal({ assistantAutomations: [...assistantAutomations, automation] });
  return { ok: true, automation };
}

export async function updateAutomation(
  id: string,
  patch: Partial<Pick<AssistantAutomation, 'name' | 'prompt' | 'schedule' | 'enabled'>>,
): Promise<{ ok: boolean; error?: string }> {
  const { assistantAutomations } = await getLocal('assistantAutomations');
  const existing = assistantAutomations.find((a) => a.id === id);
  if (!existing) return { ok: false, error: 'No such automation.' };

  const merged: AssistantAutomation = {
    ...existing,
    ...patch,
    name: (patch.name ?? existing.name).trim().slice(0, 60),
    prompt: (patch.prompt ?? existing.prompt).trim().slice(0, 500),
    schedule: cleanSchedule(patch.schedule ?? existing.schedule),
    updatedAt: Date.now(),
  };
  if (!merged.name || !merged.prompt) {
    return { ok: false, error: 'An automation needs a name and a prompt.' };
  }
  await setLocal({
    assistantAutomations: assistantAutomations.map((a) => (a.id === id ? merged : a)),
  });
  return { ok: true };
}

export async function deleteAutomation(id: string): Promise<void> {
  const { assistantAutomations } = await getLocal('assistantAutomations');
  await setLocal({ assistantAutomations: assistantAutomations.filter((a) => a.id !== id) });
}

export async function runAutomation(
  id: string,
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  const { assistantAutomations } = await getLocal('assistantAutomations');
  const automation = assistantAutomations.find((a) => a.id === id);
  if (!automation) return { ok: false, error: 'No such automation.' };
  if (!automation.enabled && !opts.force) return { ok: false, error: 'Automation is disabled.' };

  if (!(await geminiProvider.available())) {
    // Queue for an on-device (digest-only) run on the next dashboard open
    const { pendingAutomationRuns } = await getSession('pendingAutomationRuns');
    if (!pendingAutomationRuns.includes(id)) {
      await setSession({ pendingAutomationRuns: [...pendingAutomationRuns, id] });
    }
    return { ok: false, error: 'No cloud key — queued to run on-device on the next dashboard open.' };
  }
  return executeAutomation(automation, geminiProvider, opts);
}
