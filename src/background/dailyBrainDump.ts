import {
  ALARMS,
  DAILY_GATE_PAGE_PATH,
} from '../shared/constants';
import {
  gateStateForDate,
  isDailyBrainDumpComplete,
  nextLocalMidnight,
  safeOriginalUrl,
} from '../shared/dailyBrainDump';
import { localDate } from '../shared/format';
import { getLocal, setLocal } from '../shared/storage';
import { ensurePersistentDailyGateRule, syncSessionAccessRules } from './accessRules';

function gatePageUrl(original?: string): string {
  const base = chrome.runtime.getURL(DAILY_GATE_PAGE_PATH);
  return original ? `${base}#${original}` : base;
}

export async function setupDailyBrainDumpAlarm(): Promise<void> {
  await chrome.alarms.clear(ALARMS.dailyBrainDumpMidnight);
  chrome.alarms.create(ALARMS.dailyBrainDumpMidnight, { when: nextLocalMidnight() });
}

async function redirectOpenWebTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.flatMap((tab) =>
      tab.id !== undefined && tab.url
        ? [chrome.tabs.update(tab.id, { url: gatePageUrl(tab.url) })]
        : [],
    ),
  );
}

async function restoreCompletedGateTabs(): Promise<void> {
  const pattern = chrome.runtime.getURL(DAILY_GATE_PAGE_PATH) + '*';
  const tabs = await chrome.tabs.query({ url: pattern });
  await Promise.all(
    tabs.flatMap((tab) => {
      if (tab.id === undefined || !tab.url) return [];
      const original = safeOriginalUrl(new URL(tab.url).hash);
      return original ? [chrome.tabs.update(tab.id, { url: original.href })] : [];
    }),
  );
}

export interface ReconcileDailyGateOptions {
  redirectTabs?: boolean;
  restoreCompletedRedirects?: boolean;
}

export async function reconcileDailyBrainDump(
  options: ReconcileDailyGateOptions = {},
): Promise<{ complete: boolean }> {
  await ensurePersistentDailyGateRule();
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
  const complete = isDailyBrainDumpComplete(resolved);
  if (!complete && options.redirectTabs) {
    await redirectOpenWebTabs();
  } else if (complete && options.restoreCompletedRedirects) {
    await restoreCompletedGateTabs();
  }
  return { complete };
}

export async function handleDailyBrainDumpMidnight(): Promise<void> {
  await reconcileDailyBrainDump({ redirectTabs: true });
}

/** Cheap navigation safety net for a missed alarm or a timezone/date change. */
export async function ensureDailyGateDateForNavigation(): Promise<void> {
  const { dailyBrainDumpGate } = await getLocal('dailyBrainDumpGate');
  if (dailyBrainDumpGate.date !== localDate()) {
    await reconcileDailyBrainDump({ redirectTabs: true });
  }
}
