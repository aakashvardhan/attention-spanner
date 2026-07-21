import { localDate } from './format';
import type { DayStats, SrsDayStats } from './types';

/**
 * Activity scoring for the dashboard's GitHub-style contribution calendar.
 * Pure — the component only maps the returned model to DOM.
 */

export interface DayActivityParts {
  /** Active reading + watching minutes */
  minutes: number;
  sprints: number;
  articles: number;
  videos: number;
  focusBlocks: number;
  gym: boolean;
  cardsReviewed: number;
  tasks: number;
}

/**
 * Each discrete completion = 1 point; continuous quantities are normalized
 * (15 min ≈ one activity, 10 card reviews ≈ one activity) so no single
 * signal drowns the rest.
 */
export function dayActivityScore(p: DayActivityParts): number {
  return (
    p.tasks +
    p.articles +
    p.videos +
    p.sprints +
    p.focusBlocks +
    (p.gym ? 1 : 0) +
    Math.floor(p.minutes / 15) +
    Math.floor(p.cardsReviewed / 10)
  );
}

export type ActivityLevel = 0 | 1 | 2 | 3 | 4;

/** GitHub-style quartiles of the year's max; any nonzero score is at least 1 */
export function activityLevel(score: number, max: number): ActivityLevel {
  if (score <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((score / max) * 4))) as ActivityLevel;
}

export interface ActivityDay {
  /** Local date 'YYYY-MM-DD' */
  date: string;
  score: number;
  level: ActivityLevel;
  tooltip: string;
  /** After today — rendered as an invisible placeholder */
  future: boolean;
}

export interface ActivityModel {
  /** Week columns (oldest first), each exactly 7 days Mon→Sun */
  weeks: ActivityDay[][];
  monthLabels: { columnIndex: number; label: string }[];
  totalActivities: number;
  maxScore: number;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

export function formatDayTooltip(date: Date, parts: DayActivityParts, score: number): string {
  const head = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  if (score === 0) return `${head} — No activity`;
  const bits: string[] = [];
  if (parts.tasks > 0) bits.push(plural(parts.tasks, 'task'));
  if (Math.round(parts.minutes) >= 1) bits.push(`${Math.round(parts.minutes)} min`);
  if (parts.sprints > 0) bits.push(plural(parts.sprints, 'sprint'));
  if (parts.articles > 0) bits.push(plural(parts.articles, 'article'));
  if (parts.videos > 0) bits.push(plural(parts.videos, 'video'));
  if (parts.focusBlocks > 0) bits.push(plural(parts.focusBlocks, 'focus block'));
  if (parts.gym) bits.push('gym');
  if (parts.cardsReviewed > 0) bits.push(plural(parts.cardsReviewed, 'review'));
  return `${head} — ${bits.join(' · ')}`;
}

/** Monday (0) … Sunday (6) index for a date */
function weekdayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/**
 * Column count and start for a forward window: the current month plus the next
 * `months - 1` months. Starts at the Monday of the week containing the 1st of
 * the current month and runs through the Sunday of the week containing the last
 * day of the final month. Today lands near the left; later days are `future`.
 */
export function forwardMonthWindow(
  todayKey: string,
  months = 3,
): { startKey: string; weeks: number } {
  const [y, m] = todayKey.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const startMonday = new Date(first);
  startMonday.setDate(first.getDate() - weekdayIndex(first));
  const lastDay = new Date(y, m - 1 + months, 0); // last day of (current + months - 1)
  const endSunday = new Date(lastDay);
  endSunday.setDate(lastDay.getDate() + (6 - weekdayIndex(lastDay)));
  let weeks = 0;
  for (const cur = new Date(startMonday); cur <= endSunday; cur.setDate(cur.getDate() + 7)) {
    weeks++;
  }
  return { startKey: localDate(startMonday), weeks };
}

export function buildActivityDays(
  streaksDaily: Record<string, DayStats>,
  gymCheckins: Record<string, number>,
  srsDaily: Record<string, SrsDayStats>,
  todayKey: string,
  weeks = 53,
  startKey?: string,
): ActivityModel {
  const [y, m, d] = todayKey.split('-').map(Number);
  const today = new Date(y, m - 1, d);
  let startMonday: Date;
  if (startKey) {
    const [sy, sm, sd] = startKey.split('-').map(Number);
    const start = new Date(sy, sm - 1, sd);
    startMonday = new Date(start);
    startMonday.setDate(start.getDate() - weekdayIndex(start));
  } else {
    startMonday = new Date(today);
    startMonday.setDate(today.getDate() - weekdayIndex(today) - (weeks - 1) * 7);
  }

  // First pass: assemble days with scores
  const columns: { day: ActivityDay; parts: DayActivityParts; dateObj: Date }[][] = [];
  let maxScore = 0;
  let totalActivities = 0;
  for (let w = 0; w < weeks; w++) {
    const column: (typeof columns)[number] = [];
    for (let r = 0; r < 7; r++) {
      const dateObj = new Date(startMonday);
      dateObj.setDate(startMonday.getDate() + w * 7 + r);
      const date = localDate(dateObj);
      const stats = streaksDaily[date];
      const parts: DayActivityParts = {
        minutes: stats?.minutes ?? 0,
        sprints: stats?.sprints ?? 0,
        articles: stats?.articlesFinished ?? 0,
        videos: stats?.videosFinished ?? 0,
        focusBlocks: stats?.focusBlocks ?? 0,
        gym: date in gymCheckins,
        cardsReviewed: Object.values(srsDaily[date]?.reviews ?? {}).reduce((a, b) => a + b, 0),
        tasks: stats?.tasksCompleted ?? 0,
      };
      const future = date > todayKey;
      const score = future ? 0 : dayActivityScore(parts);
      maxScore = Math.max(maxScore, score);
      totalActivities += score;
      column.push({
        day: { date, score, level: 0, tooltip: '', future },
        parts,
        dateObj,
      });
    }
    columns.push(column);
  }

  // Second pass: levels + tooltips against the year's max
  const weeksOut: ActivityDay[][] = columns.map((column) =>
    column.map(({ day, parts, dateObj }) => ({
      ...day,
      level: day.future ? (0 as ActivityLevel) : activityLevel(day.score, maxScore),
      tooltip: day.future ? '' : formatDayTooltip(dateObj, parts, day.score),
    })),
  );

  // Month labels: one per month, at the column whose Monday falls in that
  // month's first week. Window-agnostic — no gap guard needed since each
  // month contributes exactly one first-week Monday, ~4–5 columns apart.
  const monthLabels: ActivityModel['monthLabels'] = [];
  for (let w = 0; w < weeks; w++) {
    const monday = new Date(startMonday);
    monday.setDate(startMonday.getDate() + w * 7);
    if (monday.getDate() <= 7) {
      monthLabels.push({
        columnIndex: w,
        label: monday.toLocaleDateString('en-US', { month: 'short' }),
      });
    }
  }

  return { weeks: weeksOut, monthLabels, totalActivities, maxScore };
}
