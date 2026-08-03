import {
  JOURNAL_ENTRY_MAX_CHARS,
  JOURNAL_MAX_DAYS,
  JOURNAL_MAX_ENTRIES_PER_DAY,
} from '../constants';
import { localDate } from '../format';
import type { DayPlan, JournalDay, JournalEntry } from '../types';

/**
 * The journal: what happened, day by day, durably.
 *
 * `assistantThread` lives in chrome.storage.session and evaporates when the
 * browser closes, so before this the assistant's only memory across restarts
 * was 50 remembered facts. The journal is the other half — episodic rather
 * than declarative. The weekly review reads it back; nothing else would have
 * the raw material to say "you planned four things on Tuesday and did one".
 *
 * Pure here, storage-backed in src/background/journal.ts (same split as
 * memory.ts: all writes happen in the worker so pages cannot race).
 */

export type Journal = Record<string, JournalDay>;

export function emptyDay(date: string): JournalDay {
  return { date, plan: null, entries: [] };
}

/**
 * Append an entry to `date`, creating the day if needed. Past the per-day cap
 * the oldest entries go — a day that fires 200 action entries is a runaway
 * loop, and the newest ones describe it just as well.
 */
export function appendEntry(
  journal: Journal,
  kind: JournalEntry['kind'],
  text: string,
  now: number,
): Journal {
  const clean = text.trim().replace(/\s+/g, ' ').slice(0, JOURNAL_ENTRY_MAX_CHARS);
  if (!clean) return journal;

  const date = localDate(new Date(now));
  const day = journal[date] ?? emptyDay(date);
  const entry: JournalEntry = { id: crypto.randomUUID(), at: now, kind, text: clean };
  const entries = [...day.entries, entry].slice(-JOURNAL_MAX_ENTRIES_PER_DAY);
  return { ...journal, [date]: { ...day, entries } };
}

/** Replace (or create) a day's plan without disturbing its entries. */
export function setPlan(journal: Journal, plan: DayPlan): Journal {
  const day = journal[plan.date] ?? emptyDay(plan.date);
  return { ...journal, [plan.date]: { ...day, plan } };
}

/** Patch the stored plan for `date`. No plan there = no-op, never a create. */
export function patchPlan(journal: Journal, date: string, patch: Partial<DayPlan>): Journal {
  const day = journal[date];
  if (!day?.plan) return journal;
  return { ...journal, [date]: { ...day, plan: { ...day.plan, ...patch } } };
}

/** Drop days older than JOURNAL_MAX_DAYS. Date keys sort lexically. */
export function pruneJournal(journal: Journal, now: number): Journal {
  const cutoff = localDate(new Date(now - JOURNAL_MAX_DAYS * 86_400_000));
  const kept: Journal = {};
  for (const [date, day] of Object.entries(journal)) {
    if (date >= cutoff) kept[date] = day;
  }
  return kept;
}

/** Days in [from, to] inclusive, oldest first. Both bounds are 'YYYY-MM-DD'. */
export function daysInRange(journal: Journal, from: string, to: string): JournalDay[] {
  return Object.values(journal)
    .filter((d) => d.date >= from && d.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Yesterday's one-line recap for the data snapshot. Deliberately just the
 * previous day: a week of history would eat the 3000-char context budget that
 * today's tasks and calendar need, and the weekly review is where the longer
 * view belongs.
 */
export function journalContextLines(journal: Journal, now = new Date()): string[] {
  const yesterday = localDate(new Date(now.getTime() - 86_400_000));
  const day = journal[yesterday];
  if (!day) return [];

  const parts: string[] = [];
  if (day.plan) {
    const done = day.plan.priorities.filter((p) => p.done).length;
    parts.push(`planned ${day.plan.priorities.length}, finished ${done}`);
    if (day.plan.reflection) parts.push(`they wrote: “${day.plan.reflection}”`);
  }
  const actions = day.entries.filter((e) => e.kind === 'action').length;
  if (actions > 0) parts.push(`${actions} action${actions === 1 ? '' : 's'} run`);

  return parts.length > 0 ? [`Yesterday (${yesterday}): ${parts.join('; ')}.`] : [];
}
