import {
  ALARMS,
  CALENDAR_REFRESH_MINUTES,
  MEETING_NOTES_REFRESH_MINUTES,
} from '../shared/constants';
import { getLocal, getSettings } from '../shared/storage';
import { nextDailyOccurrence } from '../shared/week';
import { runAutomation } from './automations';
import { refreshCalendar } from './calendar';
import { refreshMeetingNotes } from './meetingNotes';
import { refreshFeeds, updateBadge } from './feeds';
import { handleFocusPhaseEnd } from './focus';
import { fireGymReminder } from './gym';
import { fireCalendarCheck, fireEveningCheck } from './monitor';
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

export async function setupMonitorAlarms(eveningTime?: string): Promise<void> {
  await chrome.alarms.clear(ALARMS.monitorEvening);
  await chrome.alarms.clear(ALARMS.monitorCalendar);
  const hhmm = eveningTime ?? (await getSettings()).monitorEveningTime;
  if (hhmm !== '') {
    chrome.alarms.create(ALARMS.monitorEvening, {
      when: nextDailyOccurrence(hhmm),
      periodInMinutes: 24 * 60,
    });
  }
  // Created unconditionally — the handler no-ops when calendar is disconnected
  chrome.alarms.create(ALARMS.monitorCalendar, { periodInMinutes: 5 });
}

/** One alarm per enabled automation, named `automation|<id>` (nudge pattern) */
export async function setupAutomationAlarms(): Promise<void> {
  const existing = await chrome.alarms.getAll();
  await Promise.all(
    existing
      .filter((a) => a.name.startsWith(ALARMS.automationPrefix))
      .map((a) => chrome.alarms.clear(a.name)),
  );
  const { assistantAutomations } = await getLocal('assistantAutomations');
  for (const automation of assistantAutomations) {
    if (!automation.enabled) continue;
    const name = ALARMS.automationPrefix + automation.id;
    if (automation.schedule.kind === 'daily') {
      chrome.alarms.create(name, {
        when: nextDailyOccurrence(automation.schedule.time),
        periodInMinutes: 24 * 60,
      });
    } else {
      chrome.alarms.create(name, {
        delayInMinutes: automation.schedule.minutes,
        periodInMinutes: automation.schedule.minutes,
      });
    }
  }
}

function isAutomationAlarm(name: string): boolean {
  return name.startsWith(ALARMS.automationPrefix);
}

export async function setupCalendarRefreshAlarm(): Promise<void> {
  await chrome.alarms.clear(ALARMS.calendarRefresh);
  // Created unconditionally — refreshCalendar no-ops when disconnected
  chrome.alarms.create(ALARMS.calendarRefresh, { periodInMinutes: CALENDAR_REFRESH_MINUTES });
}

export async function setupMeetingNotesAlarm(): Promise<void> {
  await chrome.alarms.clear(ALARMS.meetingNotesRefresh);
  // Created unconditionally — refreshMeetingNotes no-ops when unconfigured
  chrome.alarms.create(ALARMS.meetingNotesRefresh, {
    periodInMinutes: MEETING_NOTES_REFRESH_MINUTES,
  });
}

export function handleAlarm(alarm: chrome.alarms.Alarm): void {
  if (isNudgeAlarm(alarm.name)) {
    void fireNudge(alarm.name);
    return;
  }
  if (isAutomationAlarm(alarm.name)) {
    void runAutomation(alarm.name.slice(ALARMS.automationPrefix.length));
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
    case ALARMS.calendarRefresh:
      void refreshCalendar();
      break;
    case ALARMS.meetingNotesRefresh:
      void refreshMeetingNotes();
      break;
    case ALARMS.monitorEvening:
      void fireEveningCheck();
      break;
    case ALARMS.monitorCalendar:
      void fireCalendarCheck();
      break;
  }
}
