import { localDate } from './format';
import { getLocal, setLocal } from './storage';
import type { DayActivity, Paper } from './types';

/**
 * The new tab's year-in-review heatmap: which papers were read and how many
 * focus sessions ran to the end, per local day. The service worker writes it
 * (logActivity); the page only reads.
 */

export type ActivityMetric = 'all' | 'papers' | 'focus';
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface HeatDay {
  date: string;
  papers: number;
  focus: number;
  /** Null after today: the last column is a partial week */
  level: HeatLevel | null;
}

export interface HeatModel {
  /** Week columns, oldest first, each Sunday → Saturday like GitHub's */
  weeks: HeatDay[][];
  months: { column: number; label: string }[];
  papers: number;
  focus: number;
}

const WEEKS = 53;
/** A year and a margin; older days are pruned on write */
const KEEP_DAYS = WEEKS * 7 + 7;

/** Fold one event into the log. Pure; returns the same object when nothing changed. */
export function addActivity(
  log: Record<string, DayActivity>,
  event: { paperId: string } | { focus: true },
  now: Date,
): Record<string, DayActivity> {
  const date = localDate(now);
  const day = log[date] ?? { papers: [], focus: 0 };
  if ('paperId' in event && day.papers.includes(event.paperId)) return log;
  const next =
    'paperId' in event
      ? { ...day, papers: [...day.papers, event.paperId] }
      : { ...day, focus: day.focus + 1 };
  const cutoff = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - KEEP_DAYS));
  const kept = Object.entries(log).filter(([key]) => key >= cutoff);
  return { ...Object.fromEntries(kept), [date]: next };
}

/** Service worker only, so two pages never race the read-modify-write. */
export async function logActivity(event: { paperId: string } | { focus: true }): Promise<void> {
  const { activity } = await getLocal('activity');
  const next = addActivity(activity, event, new Date());
  if (next !== activity) await setLocal({ activity: next });
}

/** GitHub's quartiles of the year's busiest day; any activity is at least 1. */
export function heatLevel(count: number, max: number): HeatLevel {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, Math.ceil((count / max) * 4)) as HeatLevel;
}

const countOf = (day: { papers: number; focus: number }, metric: ActivityMetric) =>
  metric === 'papers' ? day.papers : metric === 'focus' ? day.focus : day.papers + day.focus;

/**
 * 53 week columns ending with the week holding today. A paper's lastReadAt
 * counts too, so the papers row has a history from the day this shipped.
 */
export function buildHeatModel(
  log: Record<string, DayActivity>,
  papers: Pick<Paper, 'id' | 'lastReadAt'>[],
  metric: ActivityMetric,
  today: Date,
): HeatModel {
  const read = new Map<string, Set<string>>();
  for (const [date, day] of Object.entries(log)) read.set(date, new Set(day.papers));
  for (const paper of papers) {
    if (!paper.lastReadAt) continue;
    const date = localDate(new Date(paper.lastReadAt));
    read.set(date, (read.get(date) ?? new Set()).add(paper.id));
  }

  const todayKey = localDate(today);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay() - (WEEKS - 1) * 7);
  const days: Omit<HeatDay, 'level'>[] = [];
  for (let i = 0; i < WEEKS * 7; i++) {
    const date = localDate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    days.push({ date, papers: read.get(date)?.size ?? 0, focus: log[date]?.focus ?? 0 });
  }

  const past = days.filter((d) => d.date <= todayKey);
  const max = Math.max(0, ...past.map((d) => countOf(d, metric)));
  const weeks: HeatDay[][] = [];
  const months: HeatModel['months'] = [];
  for (let w = 0; w < WEEKS; w++) {
    const week = days.slice(w * 7, w * 7 + 7).map((d) => ({
      ...d,
      level: d.date > todayKey ? null : heatLevel(countOf(d, metric), max),
    }));
    weeks.push(week);
    // GitHub labels the first column of each month, skipping a stub at the left edge.
    const month = week[0].date.slice(0, 7);
    if (w === 0 ? Number(week[0].date.slice(8)) <= 7 : month !== weeks[w - 1][0].date.slice(0, 7)) {
      const [y, m] = month.split('-').map(Number);
      months.push({ column: w, label: new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' }) });
    }
  }

  return {
    weeks,
    months,
    papers: past.reduce((n, d) => n + d.papers, 0),
    focus: past.reduce((n, d) => n + d.focus, 0),
  };
}

export const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** GitHub's tooltip sentence: "2 papers and 1 focus session on Thursday, October 2". */
export function heatTooltip(day: HeatDay): string {
  const [y, m, d] = day.date.split('-').map(Number);
  const when = new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const parts = [
    day.papers ? plural(day.papers, 'paper') : '',
    day.focus ? plural(day.focus, 'focus session') : '',
  ].filter(Boolean);
  return `${parts.length ? parts.join(' and ') : 'No reading or focus'} on ${when}`;
}
