import { localDate } from '../format';
import { levelForXp } from '../levels';
import { dueCounts, newIntroducedToday, totalDue } from '../srs';
import { getLocal, getSettings, type LocalSchema } from '../storage';
import type {
  AnyProgress,
  FlashCard,
  Gamification,
  GymState,
  Paper,
  Settings,
  SrsDayStats,
  Streaks,
  Task,
} from '../types';
import { countInWeek, weekKey } from '../week';

/**
 * Compact plain-text snapshot of the user's data for question-answering.
 * Pure (buildDataContext) so it's unit-testable; gatherDataContext is the
 * thin storage-reading wrapper pages call. Hard-capped for Nano's small
 * context window.
 */

export const MAX_CONTEXT_CHARS = 3000;

export interface AssistantContextData {
  tasks: Task[];
  streaks: Streaks;
  gym: GymState;
  gamification: Gamification;
  flashCards: FlashCard[];
  srsDaily: Record<string, SrsDayStats>;
  papers: Paper[];
  siteTime: LocalSchema['siteTime'];
  readingProgress: Record<string, AnyProgress>;
  settings: Settings;
}

function minutes(seconds: number): number {
  return Math.round(seconds / 60);
}

export function buildDataContext(data: AssistantContextData, now = new Date()): string {
  const today = localDate(now);
  const lines: string[] = [];

  lines.push(
    `Today is ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.`,
  );

  const open = data.tasks.filter((t) => t.completedAt === null);
  if (open.length === 0) {
    lines.push('Open tasks: none. 🎉');
  } else {
    const shown = open.slice(0, 10).map((t) => {
      const snoozed = t.snoozedUntil !== null && t.snoozedUntil > now.getTime();
      return `- ${t.text}${snoozed ? ' (snoozed)' : ''}`;
    });
    lines.push(`Open tasks (${open.length}):`, ...shown);
    if (open.length > 10) lines.push(`…and ${open.length - 10} more.`);
  }

  const todayStats = data.streaks.daily[today];
  lines.push(
    `Reading streak: ${data.streaks.currentStreak} days (longest ${data.streaks.longestStreak}). ` +
      `Today: ${Math.round(todayStats?.minutes ?? 0)} min read, ${todayStats?.sprints ?? 0} sprints, ` +
      `${todayStats?.tasksCompleted ?? 0} tasks completed. Freeze tokens: ${data.streaks.freezeTokens ?? 0}.`,
  );

  const week = weekKey(now);
  lines.push(
    `Gym: ${countInWeek(data.gym.checkins, week)}/${data.settings.gymWeeklyTarget} sessions this week` +
      `${today in data.gym.checkins ? ' (checked in today)' : ''}, ` +
      `week streak ${data.gym.currentWeekStreak} (longest ${data.gym.longestWeekStreak}).`,
  );

  const { level, intoLevel, toNext } = levelForXp(data.gamification.xp);
  lines.push(`Level ${level} — ${intoLevel}/${toNext} XP into the level (${data.gamification.xp} total XP).`);

  const due = totalDue(dueCounts(data.flashCards, now.getTime(), newIntroducedToday(data.srsDaily, today)));
  lines.push(`Flashcards due now: ${due}.`);

  const reading = data.papers.filter((p) => p.status === 'reading');
  const toRead = data.papers.filter((p) => p.status === 'to-read').length;
  if (reading.length > 0 || toRead > 0) {
    const top = reading
      .slice(0, 3)
      .map((p) => `“${p.title}” (${p.progressPercent}%${p.leftOff ? `, left off: ${p.leftOff}` : ''})`)
      .join('; ');
    lines.push(`Papers: ${reading.length} reading, ${toRead} to-read.${top ? ` Reading now: ${top}.` : ''}`);
  }

  const inProgress = Object.values(data.readingProgress)
    .filter((p) => p.completedAt === null && p.maxPercent >= 5)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3);
  if (inProgress.length > 0) {
    lines.push(
      'In-progress reading/watching: ' +
        inProgress.map((p) => `“${p.title || p.url}” ${p.maxPercent}%`).join('; ') +
        '.',
    );
  }

  if (data.siteTime.date === today) {
    const hosts = Object.entries(data.siteTime.hosts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([host, secs]) => `${host} ${minutes(secs)}m`);
    if (hosts.length > 0) lines.push(`Time on tracked sites today: ${hosts.join(', ')}.`);
  }

  return lines.join('\n').slice(0, MAX_CONTEXT_CHARS);
}

export async function gatherDataContext(now = new Date()): Promise<string> {
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
  const settings = await getSettings();
  return buildDataContext({ ...data, settings }, now);
}
