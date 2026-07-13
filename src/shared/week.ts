import { localDate } from './format';

/**
 * Week math for gym streaks. Weeks are local and start on Monday; a week is
 * identified by its Monday's local date ('YYYY-MM-DD').
 */

/** Monday of the week containing `date` */
export function weekKey(date = new Date()): string {
  const d = new Date(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Mon=0 … Sun=6
  return localDate(d);
}

export function prevWeekKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - 7);
  return localDate(date);
}

/** The 7 local dates (Mon–Sun) of the week identified by `key` */
export function weekDates(key: string): string[] {
  const [y, m, d] = key.split('-').map(Number);
  const monday = new Date(y, m - 1, d);
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    return localDate(day);
  });
}

export function countInWeek(checkins: Record<string, number>, key: string): number {
  return weekDates(key).filter((date) => date in checkins).length;
}

/**
 * Whether local `now` falls inside the [start, end) quiet window. A start
 * after the end wraps overnight (22:00→08:00). Equal bounds = never quiet.
 */
export function inQuietHours(startHhmm: string, endHhmm: string, now = new Date()): boolean {
  const toMin = (hhmm: string): number | null => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    return h > 23 || m > 59 ? null : h * 60 + m;
  };
  const start = toMin(startHhmm);
  const end = toMin(endHhmm);
  if (start === null || end === null || start === end) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** Next occurrence of a local 'HH:MM' wall-clock time, as ms epoch */
export function nextDailyOccurrence(hhmm: string, now = new Date()): number {
  const [h, min] = hhmm.split(':').map(Number);
  const next = new Date(now);
  next.setHours(h, min, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}
