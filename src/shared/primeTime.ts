import { activityLevel, weekdayIndex, type ActivityLevel } from './activity';
import { localDate } from './format';
import type { DayStats } from './types';

/**
 * Prime time: when in the day the user's activity actually lands, learned from
 * the hourly ledger `DayStats.hours` (written at the one chokepoint in
 * background/streaks.ts). Pure — the component only maps this model to DOM,
 * same split as activity.ts / ActivityCalendar.tsx.
 *
 * The 7x24 grid is what you look at; the pooled 24-hour profile is what the
 * peak/dead claims are computed from, because it needs a seventh of the sample
 * to say something true.
 */

/** Points below which no peak window is asserted — a claim needs a sample */
export const MIN_POINTS = 40;

/** Contiguous hours per window. Three is wide enough to survive one noisy hour. */
const WINDOW_HOURS = 3;

/** Dead zones are only interesting while awake — 4am winning is true and useless. */
const WAKING_START = 6;
const WAKING_END = 22;

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export interface PrimeCell {
  /** 0–23 */
  hour: number;
  points: number;
  level: ActivityLevel;
  tooltip: string;
}

export interface PrimeWindow {
  startHour: number;
  /** Exclusive, may exceed 23 when the window wraps past midnight */
  endHour: number;
  /** '8-11am', '9pm-12am' */
  label: string;
}

export interface PrimeTimeModel {
  /** 7 rows Mon→Sun, each 24 cells */
  grid: PrimeCell[][];
  /** 24 entries, pooled across weekdays */
  hourProfile: number[];
  totalPoints: number;
  /** Null until totalPoints reaches minPoints — no claims from three data points */
  peak: PrimeWindow | null;
  dead: PrimeWindow | null;
  /** 1 = the current hour is the best of the 24; null while learning or if it's dead empty */
  nowRank: number | null;
  /** The current hour sits in the peak window — the component's cue to offer a focus block */
  nowInPeak: boolean;
  headline: string;
}

/**
 * Group event timestamps into `DayStats.hours`-shaped buckets, one point each.
 *
 * Used once, by the v8 migration, to seed the ledger from the timestamps the
 * extension already kept (task completions, highlights, bookmarks, notes, the
 * moment a page was opened or finished). Those are real clock times of real
 * activity, so the shape is honest even though the unit is coarser than the
 * live ledger's activity-score deltas — the punchcard only reads relative
 * weight. Days recorded after the ledger exists are never re-seeded.
 */
export function hoursFromTimestamps(timestamps: number[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const ms of timestamps) {
    if (!ms || !Number.isFinite(ms)) continue;
    const at = new Date(ms);
    if (Number.isNaN(at.getTime())) continue;
    const date = localDate(at);
    const hour = String(at.getHours());
    out[date] ??= {};
    out[date][hour] = (out[date][hour] ?? 0) + 1;
  }
  return out;
}

function hour12(hour: number): number {
  const h = hour % 12;
  return h === 0 ? 12 : h;
}

function meridiem(hour: number): 'am' | 'pm' {
  return hour % 24 < 12 ? 'am' : 'pm';
}

/** '8-11am' when the span stays in one half of the day, else '9pm-12am' */
function windowLabel(startHour: number, endHour: number): string {
  const end = endHour % 24;
  return meridiem(startHour) === meridiem(end)
    ? `${hour12(startHour)}-${hour12(end)}${meridiem(end)}`
    : `${hour12(startHour)}${meridiem(startHour)}-${hour12(end)}${meridiem(end)}`;
}

function cellTooltip(weekday: number, hour: number, points: number): string {
  const span = `${DAY_LABELS[weekday]} ${hour12(hour)}-${hour12(hour + 1)}${meridiem(hour + 1)}`;
  if (points <= 0) return `${span} — Nothing`;
  const rounded = Math.round(points);
  return `${span} — ${rounded === 1 ? '1 activity' : `${rounded} activities`}`;
}

/** Sum of `WINDOW_HOURS` hours starting at `start`, wrapping past midnight */
function windowSum(profile: number[], start: number): number {
  let sum = 0;
  for (let i = 0; i < WINDOW_HOURS; i++) sum += profile[(start + i) % 24];
  return sum;
}

/** Highest-sum window over all 24 starts, so a 10pm–1am owl window stays intact */
function bestWindow(profile: number[]): PrimeWindow {
  let start = 0;
  let best = -1;
  for (let h = 0; h < 24; h++) {
    const sum = windowSum(profile, h);
    if (sum > best) {
      best = sum;
      start = h;
    }
  }
  return { startHour: start, endHour: start + WINDOW_HOURS, label: windowLabel(start, start + WINDOW_HOURS) };
}

/** Lowest-sum window that fits entirely inside waking hours */
function worstWakingWindow(profile: number[]): PrimeWindow {
  let start = WAKING_START;
  let worst = Infinity;
  for (let h = WAKING_START; h + WINDOW_HOURS <= WAKING_END; h++) {
    const sum = windowSum(profile, h);
    if (sum < worst) {
      worst = sum;
      start = h;
    }
  }
  return { startHour: start, endHour: start + WINDOW_HOURS, label: windowLabel(start, start + WINDOW_HOURS) };
}

function inWindow(window: PrimeWindow, hour: number): boolean {
  for (let h = window.startHour; h < window.endHour; h++) {
    if (h % 24 === hour) return true;
  }
  return false;
}

function ordinalBest(rank: number): string {
  if (rank === 1) return 'best hour';
  return `${rank === 2 ? '2nd' : '3rd'}-best hour`;
}

/** Hours from `hour` forward to the start of `window`, wrapping past midnight */
function hoursUntil(hour: number, window: PrimeWindow): number {
  return (window.startHour - hour + 24) % 24;
}

export function buildPrimeTime(
  daily: Record<string, DayStats>,
  now = new Date(),
  minPoints = MIN_POINTS,
): PrimeTimeModel {
  const points: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const hourProfile = new Array<number>(24).fill(0);
  let totalPoints = 0;

  for (const [date, day] of Object.entries(daily)) {
    const [y, m, d] = date.split('-').map(Number);
    const weekday = weekdayIndex(new Date(y, m - 1, d));
    for (const [rawHour, value] of Object.entries(day.hours ?? {})) {
      const hour = Number(rawHour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !(value > 0)) continue;
      points[weekday][hour] += value;
      hourProfile[hour] += value;
      totalPoints += value;
    }
  }

  const maxCell = Math.max(...points.flat());
  const grid = points.map((row, weekday) =>
    row.map((value, hour) => ({
      hour,
      points: value,
      level: activityLevel(value, maxCell),
      tooltip: cellTooltip(weekday, hour, value),
    })),
  );

  const learning = totalPoints < minPoints;
  const peak = learning ? null : bestWindow(hourProfile);
  const dead = learning ? null : worstWakingWindow(hourProfile);

  const nowHour = now.getHours();
  const nowPoints = hourProfile[nowHour];
  const nowRank =
    learning || nowPoints <= 0
      ? null
      : hourProfile.filter((value) => value > nowPoints).length + 1;

  return {
    grid,
    hourProfile,
    totalPoints,
    peak,
    dead,
    nowRank,
    nowInPeak: peak !== null && inWindow(peak, nowHour),
    headline: buildHeadline({ learning, totalPoints, minPoints, peak, dead, nowRank, nowHour }),
  };
}

function buildHeadline({
  learning,
  totalPoints,
  minPoints,
  peak,
  dead,
  nowRank,
  nowHour,
}: {
  learning: boolean;
  totalPoints: number;
  minPoints: number;
  peak: PrimeWindow | null;
  dead: PrimeWindow | null;
  nowRank: number | null;
  nowHour: number;
}): string {
  if (learning || !peak || !dead) {
    return `Learning your rhythm — ${Math.round(totalPoints)} of the ${minPoints} activities needed before this calls a peak window.`;
  }
  if (nowRank !== null && nowRank <= 3) {
    return `You're in your ${ordinalBest(nowRank)}. Start the hard thing.`;
  }
  // A weak hour can still sit inside the best 3-hour block; say so rather than
  // telling the user their peak is "0 hours out"
  if (inWindow(peak, nowHour)) {
    return 'You are inside your peak window. Start the hard thing.';
  }
  if (inWindow(dead, nowHour)) {
    return 'This is your dead zone. Do admin, not deep work.';
  }
  const until = hoursUntil(nowHour, peak);
  return `Peak is ${peak.label}. ${until === 1 ? '1 hour' : `${until} hours`} out.`;
}
