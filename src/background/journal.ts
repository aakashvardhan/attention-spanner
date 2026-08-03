import {
  appendEntry,
  patchPlan as patchPlanPure,
  pruneJournal,
  setPlan as setPlanPure,
} from '../shared/ai/journal';
import { getLocal, setLocal } from '../shared/storage';
import type { DayPlan, JournalEntry } from '../shared/types';

/**
 * Journal writes, all in the service worker so the newtab, side panel and an
 * alarm-driven automation can't clobber each other's read-modify-writes (the
 * same rule memory.ts and tasks.ts state). The logic itself is pure and lives
 * in shared/ai/journal.ts.
 *
 * Every write prunes, so the retention window needs no separate alarm.
 */

export async function recordEntry(kind: JournalEntry['kind'], text: string): Promise<void> {
  const { assistantJournal } = await getLocal('assistantJournal');
  const now = Date.now();
  const next = pruneJournal(appendEntry(assistantJournal, kind, text, now), now);
  await setLocal({ assistantJournal: next });
}

export async function savePlan(plan: DayPlan): Promise<void> {
  const { assistantJournal } = await getLocal('assistantJournal');
  const next = pruneJournal(setPlanPure(assistantJournal, plan), Date.now());
  await setLocal({ assistantJournal: next });
}

export async function patchDayPlan(date: string, patch: Partial<DayPlan>): Promise<void> {
  const { assistantJournal } = await getLocal('assistantJournal');
  await setLocal({ assistantJournal: patchPlanPure(assistantJournal, date, patch) });
}

/**
 * Best-effort — a journal write must never sink the thing it is recording.
 * Callers are briefing/automation/monitor paths whose real job is elsewhere.
 */
export function recordEntrySafe(kind: JournalEntry['kind'], text: string): void {
  void recordEntry(kind, text).catch(() => undefined);
}
