import { todayEvents } from '../calendar';
import { localDate } from '../format';
import { dueCounts, newIntroducedToday, totalDue } from '../srs';
import { getLocal, getSettings, setLocal } from '../storage';
import { countInWeek, weekKey } from '../week';
import { newTurn } from './assistantTypes';
import { buildDataContext, computeFeedUnread, type AssistantContextData } from './context';
import { nanoProvider } from './nanoProvider';
import { stripEmoji } from './tts';

/**
 * Morning briefing: generated once per local day on the first newtab open
 * (page context — the Nano rule), stored in chrome.storage.local, rendered
 * as a pinned message in the assistant card. Nano-unavailable falls back to
 * a deterministic template so the card always has something to say.
 */

export const BRIEFING_MAX_CHARS = 600;

export function buildBriefingPrompt(context: string): string {
  return (
    'You write a tiny morning status line for a person with ADHD using a reading/productivity ' +
    'extension. From the data snapshot, write 2-3 blunt, concrete sentences: state the single ' +
    'most urgent thing first (a due task, cards piling up, a streak about to break), then at ' +
    'most one secondary item. No greetings, no praise, no pep talk, no emoji, no lists, no ' +
    'headings, no questions back, no invented facts.\n\nData snapshot:\n' +
    context
  );
}

/** Deterministic fallback — always renders something sane (pure, tested) */
export function templateBriefing(data: AssistantContextData, now = new Date()): string {
  const parts: string[] = [];
  const openTasks = data.tasks.filter((t) => t.completedAt === null);

  const todayStats = data.streaks.daily[localDate(now)];
  const activeToday = (todayStats?.minutes ?? 0) > 0 || (todayStats?.sprints ?? 0) > 0;
  if (data.streaks.currentStreak > 0 && !activeToday) {
    parts.push(
      `${data.streaks.currentStreak}-day reading streak, nothing counted today. One sprint keeps it.`,
    );
  } else if (data.streaks.currentStreak > 0) {
    parts.push(`${data.streaks.currentStreak}-day reading streak. Keep it alive today.`);
  } else {
    parts.push('No streak. One 5-minute sprint starts one.');
  }

  if (data.calendar.connected) {
    const meetings = todayEvents(data.calendar.events, now).filter((e) => !e.allDay);
    if (meetings.length > 0) {
      const first = meetings[0];
      const time = new Date(first.startMs).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      });
      parts.push(
        `${meetings.length} meeting${meetings.length === 1 ? '' : 's'} today — first: ${first.title} at ${time}.`,
      );
    }
  }

  if (openTasks.length > 0) {
    parts.push(
      `${openTasks.length} task${openTasks.length === 1 ? '' : 's'} open; first up: “${openTasks[0].text}”.`,
    );
  }

  const due = totalDue(
    dueCounts(data.flashCards, now.getTime(), newIntroducedToday(data.srsDaily, localDate(now))),
  );
  if (due > 0) {
    parts.push(`${due} flashcard${due === 1 ? '' : 's'} due for review.`);
  }

  if (data.feedUnread.count > 0) {
    const top = data.feedUnread.topTitles[0];
    parts.push(
      `${data.feedUnread.count} unread article${data.feedUnread.count === 1 ? '' : 's'}${top ? ` — newest: “${top}”` : ''}.`,
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
    'calendar',
    'assistantMemory',
    'cachedItems',
    'readItems',
  );
  const contextData: AssistantContextData = {
    ...data,
    settings,
    feedUnread: computeFeedUnread(data.cachedItems, data.readItems),
  };

  let text = templateBriefing(contextData, now);
  try {
    if (await nanoProvider.available()) {
      const reply = await nanoProvider.generate({
        system: buildBriefingPrompt(buildDataContext(contextData, now)),
        turns: [newTurn('user', 'Write my morning check-in for today.')],
      });
      const generated = stripEmoji(reply.text.trim()).slice(0, BRIEFING_MAX_CHARS);
      if (generated) text = generated;
    }
  } catch {
    // template already in place
  }
  await setLocal({ assistantBriefing: { date: today, text } });
}
