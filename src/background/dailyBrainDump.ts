import { ALARMS } from '../shared/constants';
import {
  gateStateForDate,
  isDailyBrainDumpComplete,
  nextLocalMidnight,
} from '../shared/dailyBrainDump';
import { localDate } from '../shared/format';
import { getLocal, setLocal } from '../shared/storage';
import { removeLegacyDailyGateRule, syncSessionAccessRules } from './accessRules';

export async function setupDailyBrainDumpAlarm(): Promise<void> {
  await chrome.alarms.clear(ALARMS.dailyBrainDumpMidnight);
  chrome.alarms.create(ALARMS.dailyBrainDumpMidnight, { when: nextLocalMidnight() });
}

/**
 * Roll the gate to today and make sure the old browser-wide redirect is gone.
 *
 * The gate no longer blocks anything: it used to rewrite every open tab at
 * midnight and hold all browsing behind a DNR redirect until 20 characters were
 * typed, which is a toll charged every morning before the extension has done
 * anything for you. It is a newtab prompt now, and the dashboard is what shows
 * it — see src/pages/newtab/Dashboard.tsx.
 */
export async function reconcileDailyBrainDump(): Promise<{ complete: boolean }> {
  await removeLegacyDailyGateRule();
  const { dailyBrainDumpGate, notes } = await getLocal('dailyBrainDumpGate', 'notes');
  const resolved = gateStateForDate(dailyBrainDumpGate, notes);
  if (
    resolved.date !== dailyBrainDumpGate.date ||
    resolved.completedAt !== dailyBrainDumpGate.completedAt ||
    resolved.noteId !== dailyBrainDumpGate.noteId
  ) {
    await setLocal({ dailyBrainDumpGate: resolved });
  }

  await syncSessionAccessRules();
  await setupDailyBrainDumpAlarm();
  return { complete: isDailyBrainDumpComplete(resolved) };
}

export async function handleDailyBrainDumpMidnight(): Promise<void> {
  await reconcileDailyBrainDump();
}

/** Cheap navigation safety net for a missed alarm or a timezone/date change. */
export async function ensureDailyGateDateForNavigation(): Promise<void> {
  const { dailyBrainDumpGate } = await getLocal('dailyBrainDumpGate');
  if (dailyBrainDumpGate.date !== localDate()) {
    await reconcileDailyBrainDump();
  }
}
