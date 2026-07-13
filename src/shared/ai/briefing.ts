import { localDate } from '../format';
import { getLocal, getSettings, setLocal } from '../storage';
import { countInWeek, weekKey } from '../week';
import { newTurn } from './assistantTypes';
import { buildDataContext, type AssistantContextData } from './context';
import { nanoProvider } from './nanoProvider';

/**
 * Morning briefing: generated once per local day on the first newtab open
 * (page context — the Nano rule), stored in chrome.storage.local, rendered
 * as a pinned message in the assistant card. Nano-unavailable falls back to
 * a deterministic template so the card always has something to say.
 */

export const BRIEFING_MAX_CHARS = 600;

export function buildBriefingPrompt(context: string): string {
  return (
    'You write a tiny morning check-in for a person with ADHD using a reading/productivity ' +
    'extension. From the data snapshot, write 2-4 warm, concrete sentences: acknowledge one ' +
    'win or streak worth protecting, then point at the single most useful next thing (a due ' +
    'task, cards to review, gym gap, or article to finish). No lists, no headings, no ' +
    'questions back, no invented facts.\n\nData snapshot:\n' +
    context
  );
}

/** Deterministic fallback — always renders something sane (pure, tested) */
export function templateBriefing(data: AssistantContextData, now = new Date()): string {
  const parts: string[] = [];
  const openTasks = data.tasks.filter((t) => t.completedAt === null);

  if (data.streaks.currentStreak > 0) {
    parts.push(`You're on a ${data.streaks.currentStreak}-day reading streak — keep it alive today.`);
  } else {
    parts.push('Fresh day, fresh start — a single 5-minute sprint gets a streak going.');
  }

  if (openTasks.length > 0) {
    parts.push(
      `${openTasks.length} task${openTasks.length === 1 ? '' : 's'} open; first up: “${openTasks[0].text}”.`,
    );
  }

  const gymCount = countInWeek(data.gym.checkins, weekKey(now));
  if (gymCount < data.settings.gymWeeklyTarget) {
    parts.push(`Gym: ${gymCount}/${data.settings.gymWeeklyTarget} this week.`);
  }

  return parts.join(' ').slice(0, BRIEFING_MAX_CHARS);
}

/** Generate today's briefing if it doesn't exist yet. Call from page mount. */
export async function maybeGenerateBriefing(now = new Date()): Promise<void> {
  const today = localDate(now);
  const [{ assistantBriefing }, settings] = await Promise.all([
    getLocal('assistantBriefing'),
    getSettings(),
  ]);
  if (!settings.assistantEnabled || assistantBriefing?.date === today) return;

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
  );
  const contextData: AssistantContextData = { ...data, settings };

  let text = templateBriefing(contextData, now);
  try {
    if (await nanoProvider.available()) {
      const reply = await nanoProvider.generate({
        system: buildBriefingPrompt(buildDataContext(contextData, now)),
        turns: [newTurn('user', 'Write my morning check-in for today.')],
      });
      const generated = reply.text.trim().slice(0, BRIEFING_MAX_CHARS);
      if (generated) text = generated;
    }
  } catch {
    // template already in place
  }
  await setLocal({ assistantBriefing: { date: today, text } });
}
