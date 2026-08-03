import { todayEvents } from '../calendar';
import { localDate } from '../format';
import { sendMessage } from '../messages';
import { buildPrimeTime } from '../primeTime';
import { getLocal, getSettings } from '../storage';
import type { DayPlan, PlanBlock, PlanPriority, Task } from '../types';
import { newTurn } from './assistantTypes';
import { buildDataContext, computeFeedUnread, type AssistantContextData } from './context';
import { nanoProvider } from './nanoProvider';
import { cloudProviderFor, hasCloudKey } from './cloud';
import { stripEmoji } from './tts';

/**
 * The day plan: three priorities and a rough shape for the day, generated once
 * per local day and kept in the journal.
 *
 * Distinct from the morning briefing on purpose. The briefing is a sentence
 * that gets overwritten tomorrow; a plan is a record — it can be ticked off
 * during the day and read back on Friday, which is the only way a weekly
 * review can say anything true about what actually got done.
 *
 * Same provider discipline as briefing.ts: templateDayPlan is pure and always
 * produces something usable, the model only improves on it.
 */

export const MAX_PRIORITIES = 3;
export const REFLECTION_MAX_CHARS = 200;
/** Deep-work blocks the template proposes; long enough to matter, short enough to start */
const DEEP_WORK_MINUTES = 90;

function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 'HH:MM' + minutes, clamped to the same day (23:59 rather than wrapping). */
export function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + minutes;
  if (total >= 24 * 60) return '23:59';
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Oldest first — the task that has sat longest is the one being avoided. */
function pickPriorityTasks(tasks: Task[], now: Date): Task[] {
  return tasks
    .filter((t) => t.completedAt === null)
    .filter((t) => t.snoozedUntil === null || t.snoozedUntil <= now.getTime())
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, MAX_PRIORITIES);
}

/**
 * The deterministic plan. Calendar events become fixed blocks; one deep-work
 * block is proposed in the prime-time peak window when the ledger has enough
 * sample to name one, and mid-morning otherwise — a guessed peak is worse than
 * an honest default, which is why buildPrimeTime returns null while learning.
 */
export function templateDayPlan(data: AssistantContextData, now = new Date()): DayPlan {
  const priorities: PlanPriority[] = pickPriorityTasks(data.tasks, now).map((t) => ({
    text: t.text,
    taskId: t.id,
    estimateMin: 30,
    done: false,
  }));

  const blocks: PlanBlock[] = [];
  if (data.calendar.connected) {
    for (const event of todayEvents(data.calendar.events, now)) {
      if (event.allDay) continue;
      blocks.push({
        start: hhmm(new Date(event.startMs)),
        end: hhmm(new Date(event.endMs)),
        label: event.title,
        source: 'calendar',
      });
    }
  }

  if (priorities.length > 0) {
    const prime = buildPrimeTime(data.streaks.daily, now);
    const startHour = prime.peak ? prime.peak.startHour : 9;
    const start = `${String(startHour).padStart(2, '0')}:00`;
    blocks.push({
      start,
      end: addMinutes(start, DEEP_WORK_MINUTES),
      label: `Deep work: ${priorities[0].text}`,
      source: 'plan',
    });
  }

  blocks.sort((a, b) => a.start.localeCompare(b.start));

  return {
    date: localDate(now),
    priorities,
    blocks,
    generatedAt: now.getTime(),
    reviewedAt: null,
    reflection: '',
  };
}

export function buildPlanPrompt(context: string): string {
  return (
    'You plan one day for a person with ADHD using a reading/productivity extension. From the ' +
    `data snapshot, choose at most ${MAX_PRIORITIES} priorities for today and estimate each in ` +
    'minutes. Pick what is genuinely most consequential — an overdue task, a deadline implied by ' +
    'a meeting — not simply the newest. Phrase each as a concrete action starting with a verb. ' +
    'Never invent tasks, meetings or facts that are not in the snapshot; if there is little to ' +
    'do, return fewer priorities rather than filler. No emoji.\n\nData snapshot:\n' +
    context
  );
}

/** Priorities only — blocks stay deterministic (a model guessing at clock times is worse). */
export function buildDayPlanSchema(): object {
  return {
    type: 'object',
    required: ['priorities'],
    additionalProperties: false,
    properties: {
      priorities: {
        type: 'array',
        maxItems: MAX_PRIORITIES,
        items: {
          type: 'object',
          required: ['text', 'estimateMin'],
          additionalProperties: false,
          properties: {
            text: { type: 'string', description: 'Concrete action, starts with a verb' },
            estimateMin: { type: 'number', description: 'Realistic minutes, 5-240' },
          },
        },
      },
    },
  };
}

/**
 * Fold a model reply into the template plan. The model may rewrite and reorder
 * priorities; anything it produces that matches an open task by text keeps that
 * task's id, so ticking the priority can still complete the real task. Invalid
 * replies leave the template plan untouched.
 */
export function mergePlanReply(base: DayPlan, raw: string, openTasks: Task[]): DayPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return base;
  }
  const list = (parsed as { priorities?: unknown })?.priorities;
  if (!Array.isArray(list)) return base;

  // Cap after filtering, not before — a blank entry from the model must not
  // cost a real priority its slot.
  const priorities: PlanPriority[] = [];
  for (const item of list) {
    if (priorities.length === MAX_PRIORITIES) break;
    const text = stripEmoji(String((item as { text?: unknown })?.text ?? '').trim());
    if (!text) continue;
    const rawEstimate = Number((item as { estimateMin?: unknown })?.estimateMin);
    const estimateMin = Number.isFinite(rawEstimate)
      ? Math.min(240, Math.max(5, Math.round(rawEstimate)))
      : 30;
    const match = openTasks.find((t) => t.text.toLowerCase() === text.toLowerCase());
    priorities.push({ text, taskId: match?.id ?? null, estimateMin, done: false });
  }
  if (priorities.length === 0) return base;

  // The first priority anchors the deep-work block, so relabel it to match
  const blocks = base.blocks.map((b) =>
    b.source === 'plan' && b.label.startsWith('Deep work:')
      ? { ...b, label: `Deep work: ${priorities[0].text}` }
      : b,
  );
  return { ...base, priorities, blocks };
}

async function loadContextData(): Promise<AssistantContextData> {
  const data = await getLocal(
    'tasks',
    'streaks',
    'gym',
    'gamification',
    'flashCards',
    'srsDaily',
    'papers',
    'siteTime',
    'readingProgress',
    'calendar',
    'assistantMemory',
    'assistantProfile',
    'assistantJournal',
    'cachedItems',
    'readItems',
  );
  const settings = await getSettings();
  return { ...data, settings, feedUnread: computeFeedUnread(data.cachedItems, data.readItems) };
}

/**
 * Build today's plan and store it. `force` regenerates over an existing plan
 * (the plan_day tool); without it this is the once-a-day dashboard-mount path,
 * and a plan the user has already been ticking is never overwritten.
 *
 * Nano runs here too — the schema is one array of two-field objects, well
 * inside its constraint budget, unlike the automation proposal schema.
 */
export async function generateDayPlan(
  opts: { force?: boolean } = {},
  now = new Date(),
): Promise<DayPlan | null> {
  const today = localDate(now);
  const [{ assistantJournal }, settings] = await Promise.all([
    getLocal('assistantJournal'),
    getSettings(),
  ]);
  if (!settings.assistantEnabled) return null;

  // An existing plan is never overwritten — except an empty one. The first
  // dashboard open of the day can land before there is anything to plan
  // (a fresh install, or tasks added later), and "nothing on the list" would
  // then stick for the rest of the day. A plan the user has already closed out
  // is theirs, empty or not.
  const existing = assistantJournal[today]?.plan ?? null;
  const worthKeeping =
    existing !== null && (existing.priorities.length > 0 || existing.reviewedAt !== null);
  if (worthKeeping && !opts.force) return existing;

  const data = await loadContextData();
  let plan = templateDayPlan(data, now);

  // Cloud when a key is configured (it also runs in the worker); Nano otherwise
  const cloud = cloudProviderFor(settings);
  const provider = hasCloudKey(settings) ? cloud : nanoProvider;
  try {
    if (await provider.available()) {
      const reply = await provider.generate({
        system: buildPlanPrompt(buildDataContext(data, now)),
        turns: [newTurn('user', 'Plan my day.')],
        responseSchema: buildDayPlanSchema(),
      });
      plan = mergePlanReply(
        plan,
        reply.text,
        data.tasks.filter((t) => t.completedAt === null),
      );
    }
  } catch {
    // template plan already in place
  }

  await sendMessage({ type: 'JOURNAL_SAVE_PLAN', plan });
  return plan;
}

/** Dashboard-mount entry point, mirroring maybeGenerateBriefing. */
export async function maybeGenerateDayPlan(now = new Date()): Promise<void> {
  await generateDayPlan({}, now).catch(() => undefined);
}

/** One line summarising a plan, for the tool reply and the palette footer. */
export function describePlan(plan: DayPlan): string {
  if (plan.priorities.length === 0) return 'Nothing on the list today — add a task and re-plan.';
  const items = plan.priorities.map((p) => `${p.text} (${p.estimateMin}m)`).join('; ');
  const blocks = plan.blocks.length;
  return `Today: ${items}.${blocks > 0 ? ` ${blocks} block${blocks === 1 ? '' : 's'} on the schedule.` : ''}`;
}
