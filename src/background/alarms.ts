import { ALARMS } from '../shared/constants';
import { getSettings } from '../shared/storage';
import { nextDailyOccurrence } from '../shared/week';
import { refreshFeeds, updateBadge } from './feeds';
import { handleFocusPhaseEnd } from './focus';
import { fireGymReminder } from './gym';
import { flushQueue, sweepUnpushedNotes } from './notion';
import { fireNudge, isNudgeAlarm } from './nudges';
import { finishSprint } from './streaks';
import { showTaskDigest } from './tasks';

export async function setupRefreshAlarm(intervalMinutes?: number): Promise<void> {
  await chrome.alarms.clear(ALARMS.refreshFeeds);
  const minutes = intervalMinutes ?? (await getSettings()).refreshInterval;
  chrome.alarms.create(ALARMS.refreshFeeds, { periodInMinutes: minutes });
}

export async function setupTaskReminderAlarm(intervalMinutes?: number): Promise<void> {
  await chrome.alarms.clear(ALARMS.taskReminders);
  const minutes = intervalMinutes ?? (await getSettings()).taskReminderIntervalMinutes;
  if (minutes > 0) {
    chrome.alarms.create(ALARMS.taskReminders, { periodInMinutes: minutes });
  }
}

export async function setupGymReminderAlarm(time?: string): Promise<void> {
  await chrome.alarms.clear(ALARMS.gymReminder);
  const hhmm = time ?? (await getSettings()).gymReminderTime;
  if (hhmm === '') return;
  chrome.alarms.create(ALARMS.gymReminder, {
    when: nextDailyOccurrence(hhmm),
    periodInMinutes: 24 * 60,
  });
}

export async function setupNotionFlushAlarm(): Promise<void> {
  await chrome.alarms.clear(ALARMS.notionFlush);
  // Created unconditionally — the handler no-ops in microseconds when
  // the queue is empty or Notion is unconfigured
  chrome.alarms.create(ALARMS.notionFlush, { periodInMinutes: 10 });
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
    case ALARMS.taskReminders:
      void showTaskDigest();
      break;
    case ALARMS.sprintEnd:
      void finishSprint();
      break;
    case ALARMS.gymReminder:
    case ALARMS.gymReminderSnooze:
      void fireGymReminder();
      break;
    case ALARMS.focusPhaseEnd:
      void handleFocusPhaseEnd();
      break;
    case ALARMS.focusBadgeTick:
      void updateBadge();
      break;
    case ALARMS.notionFlush:
      void flushQueue();
      void sweepUnpushedNotes();
      break;
  }
}
