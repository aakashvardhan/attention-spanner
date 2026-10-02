import { ALARMS } from '../shared/constants';
import { getSettings } from '../shared/storage';
import { refreshFeeds, updateBadge } from './feeds';
import { handleFocusPhaseEnd } from './focus';
import { fireNudge, isNudgeAlarm } from './nudges';

/**
 * Alarms belonging to features that have been cut. An alarm outlives the code
 * that created it — it survives updates and keeps waking the service worker to
 * hit a `switch` with no matching case. Clearing by literal name on purpose:
 * the constants these used to reference are gone.
 */
const RETIRED_ALARMS = [
  'daily-brain-dump-midnight',
  'refresh-jobs',
  'task-reminders',
  'sprint-end',
  'gym-reminder',
  'gym-reminder-snooze',
  'calendar-refresh',
  'monitor-evening',
  'monitor-calendar',
  'gmail-triage',
];

export async function clearRetiredAlarms(): Promise<void> {
  for (const name of RETIRED_ALARMS) await chrome.alarms.clear(name);
  // Automations were one alarm per rule, named by id — clear the whole family.
  const existing = await chrome.alarms.getAll();
  await Promise.all(
    existing.filter((a) => a.name.startsWith('automation|')).map((a) => chrome.alarms.clear(a.name)),
  );
}

export async function setupRefreshAlarm(intervalMinutes?: number): Promise<void> {
  await chrome.alarms.clear(ALARMS.refreshFeeds);
  const minutes = intervalMinutes ?? (await getSettings()).refreshInterval;
  chrome.alarms.create(ALARMS.refreshFeeds, { periodInMinutes: minutes });
}

export function handleAlarm(alarm: chrome.alarms.Alarm): void {
  if (isNudgeAlarm(alarm.name)) {
    void fireNudge(alarm.name);
    return;
  }
  switch (alarm.name) {
    case ALARMS.refreshFeeds:
      void refreshFeeds();
      break;
    case ALARMS.focusPhaseEnd:
      void handleFocusPhaseEnd();
      break;
    case ALARMS.focusBadgeTick:
      void updateBadge();
      break;
  }
}
