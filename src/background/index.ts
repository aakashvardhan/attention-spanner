import { cacheInvalidateTag } from '../shared/ai/cache';
import { ALARMS, CAPTURE_WINDOW_TASK, NEWTAB_PAGE_PATH, NOTIFICATION_IDS } from '../shared/constants';
import { migrate } from '../shared/storage';
import { setLocalDispatcher, type Message } from '../shared/messages';
import type { Settings } from '../shared/types';
import {
  handleAlarm,
  setupAutomationAlarms,
  setupCalendarRefreshAlarm,
  setupGymReminderAlarm,
  setupMeetingNotesAlarm,
  setupMonitorAlarms,
  setupNotionFlushAlarm,
  setupRefreshAlarm,
  setupTaskReminderAlarm,
} from './alarms';
import { refreshCalendar } from './calendar';
import { refreshMeetingNotes } from './meetingNotes';
import { flushQueue, handleTokenChanged } from './notion';
import { bookmarkFromContextMenu } from './bookmarks';
import { refreshFeeds, updateBadge } from './feeds';
import { reconcileFocusOnStartup, refreshFocusRules } from './focus';
import { gymCheckin, recomputeGymStreak } from './gym';
import { recomputeWarmupStreak } from './warmup';
import {
  dismissNudgesForArticle,
  isNudgeNotification,
  resumeArticle,
} from './nudges';
import { isMonitorNotification } from './monitor';
import { recomputeStreak } from './streaks';
import { pruneCompletedTasks, snoozeOpenTasks } from './tasks';
import { maybeInjectTimePill } from './timePill';
import { markPaperReadingByUrl } from './papers';
import { maybeInterceptPdf } from './pdfIntercept';
import { openDashboard, syncWakeWordListener } from './offscreen';
import { handleTabRemoved, maybeInjectTracker } from './tracking';
import { maybeInjectVideoTracker } from './videoTracking';
import { initSync, onLocalChanged } from './sync';
// Side-effect import: registers the Firestore transport + auth listener on every
// service-worker instantiation (guarded by whether firebaseConfig is filled in).
import './firestoreBackend';
import { dispatch, handleMessage } from './router';

/**
 * MV3 service worker entry. Every listener is registered synchronously at
 * top level; no module-level mutable state — handlers rehydrate from storage.
 */

const CAPTURE_WINDOW = CAPTURE_WINDOW_TASK;

async function openCaptureWindow(): Promise<void> {
  let left: number | undefined;
  let top: number | undefined;
  try {
    const current = await chrome.windows.getLastFocused();
    if (
      current.left !== undefined &&
      current.top !== undefined &&
      current.width !== undefined &&
      current.height !== undefined
    ) {
      left = Math.round(current.left + (current.width - CAPTURE_WINDOW.width) / 2);
      top = Math.round(current.top + (current.height - CAPTURE_WINDOW.height) / 3);
    }
  } catch {
    // No focused window (e.g. all minimized) — let Chrome pick the position
  }
  await chrome.windows.create({
    url: chrome.runtime.getURL('src/pages/capture/index.html'),
    type: 'popup',
    focused: true,
    ...CAPTURE_WINDOW,
    ...(left !== undefined && top !== undefined ? { left, top } : {}),
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await migrate();
    await setupRefreshAlarm();
    await setupTaskReminderAlarm();
    await setupGymReminderAlarm();
    await setupNotionFlushAlarm();
    await setupCalendarRefreshAlarm();
    await setupMeetingNotesAlarm();
    await setupMonitorAlarms();
    await setupAutomationAlarms();
    await reconcileFocusOnStartup();
    // Extension updates can land mid-gap; recompute so stale streaks don't
    // display until the next browser restart
    await recomputeStreak();
    await recomputeGymStreak();
    await recomputeWarmupStreak();
    // onInstalled also fires on extension reloads — clear before re-creating
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: 'bookmark-link',
      title: 'Bookmark in Reader',
      contexts: ['page', 'link'],
    });
    await refreshFeeds();
    // Resume cloud sync if signed in (inert until a transport is registered)
    await initSync();
    await syncWakeWordListener();
  })();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'bookmark-link') {
    void bookmarkFromContextMenu(info, tab);
  }
});

chrome.runtime.onStartup.addListener(() => {
  void pruneCompletedTasks();
  void updateBadge();
  void recomputeStreak();
  void recomputeGymStreak();
  void recomputeWarmupStreak();
  // Re-anchor the daily reminders to the wall clock (bounds DST drift)
  void setupGymReminderAlarm();
  void setupMonitorAlarms();
  void setupAutomationAlarms();
  void reconcileFocusOnStartup();
  // Drain Notion pushes left queued when the previous SW instance died
  void flushQueue();
  void refreshCalendar();
  void refreshMeetingNotes();
  // Resume cloud sync if signed in (inert until a transport is registered)
  void initSync();
  void syncWakeWordListener();
});

chrome.alarms.onAlarm.addListener(handleAlarm);

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) =>
  handleMessage(msg, sender, sendResponse),
);

// sendMessage from the SW itself never reaches the listener above — register
// the router as the in-process dispatcher so tools are runnable here too
// (agent runs, automations). Pages/offscreen keep the runtime path.
setLocalDispatcher((msg) => dispatch(msg, {} as chrome.runtime.MessageSender));

chrome.commands.onCommand.addListener((command) => {
  if (command === 'quick-capture-task') {
    void openCaptureWindow();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  // Mirror changed collections to the cloud (no-op until sync is running)
  onLocalChanged(changes);

  // Badge is derived state — recompute whenever its inputs change
  // (focusSession flips it between countdown and unread-count modes)
  if (changes.cachedItems || changes.readItems || changes.focusSession) {
    void updateBadge();
  }

  // Automation schedules changed — re-arm their alarms
  if (changes.assistantAutomations) {
    void setupAutomationAlarms();
  }

  // Any user-data mutation voids the assistant's cached context and answers
  if (
    changes.tasks ||
    changes.notes ||
    changes.flashCards ||
    changes.flashNotes ||
    changes.decks ||
    changes.papers ||
    changes.gym ||
    changes.streaks ||
    changes.gamification ||
    changes.bookmarks ||
    changes.calendar ||
    changes.assistantMemory ||
    changes.readingProgress
  ) {
    void cacheInvalidateTag('data');
  }

  // Re-arm alarms when their intervals change
  if (changes.settings) {
    const oldSettings = (changes.settings.oldValue ?? {}) as Partial<Settings>;
    const newSettings = (changes.settings.newValue ?? {}) as Partial<Settings>;
    if (oldSettings.refreshInterval !== newSettings.refreshInterval) {
      void setupRefreshAlarm(newSettings.refreshInterval);
    }
    if (oldSettings.taskReminderIntervalMinutes !== newSettings.taskReminderIntervalMinutes) {
      void setupTaskReminderAlarm(newSettings.taskReminderIntervalMinutes);
    }
    if (oldSettings.gymReminderTime !== newSettings.gymReminderTime) {
      void setupGymReminderAlarm(newSettings.gymReminderTime);
    }
    if (oldSettings.monitorEveningTime !== newSettings.monitorEveningTime) {
      void setupMonitorAlarms(newSettings.monitorEveningTime);
    }
    // A re-pasted token lifts the 401 pause and drains the queue immediately
    if (oldSettings.notionToken !== newSettings.notionToken && newSettings.notionToken) {
      void handleTokenChanged();
    }
    // Picking a meeting-notes database populates the card immediately
    if (
      oldSettings.notionMeetingNotesDbId !== newSettings.notionMeetingNotesDbId &&
      newSettings.notionMeetingNotesDbId
    ) {
      void refreshMeetingNotes(true);
    }
    // Arrays need a structural compare, unlike the scalar settings above
    if (
      JSON.stringify(oldSettings.focusBlocklist) !== JSON.stringify(newSettings.focusBlocklist) &&
      newSettings.focusBlocklist
    ) {
      void refreshFocusRules(newSettings.focusBlocklist);
    }
    if (
      oldSettings.assistantWakeWordEnabled !== newSettings.assistantWakeWordEnabled ||
      oldSettings.assistantEnabled !== newSettings.assistantEnabled
    ) {
      void syncWakeWordListener();
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // PDF navigations bounce into the in-extension reader (unless bypassed).
  // Checked first so the trackers below never run against a soon-gone page.
  if (changeInfo.url) {
    void maybeInterceptPdf(tabId, changeInfo.url);
  }
  if (changeInfo.status === 'complete' && tab.url) {
    void maybeInjectTracker(tabId, tab.url);
    void maybeInjectTimePill(tabId, tab.url);
    // URL-only match — works even in PDF viewers our content scripts can't enter
    void markPaperReadingByUrl(tab.url);
  }
  // YouTube is an SPA: pushState navs fire onUpdated with changeInfo.url but
  // no 'complete'. The in-page guard makes repeated injections harmless.
  const navUrl = changeInfo.url ?? (changeInfo.status === 'complete' ? tab.url : undefined);
  if (navUrl) {
    void maybeInjectVideoTracker(tabId, navUrl);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleTabRemoved(tabId);
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (notificationId === NOTIFICATION_IDS.taskDigest) {
    chrome.notifications.clear(notificationId);
    if (buttonIndex === 0) {
      void snoozeOpenTasks(60 * 60 * 1000);
    } else {
      void chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/popup/index.html') });
    }
    return;
  }
  if (isNudgeNotification(notificationId)) {
    chrome.notifications.clear(notificationId);
    const key = notificationId.slice(NOTIFICATION_IDS.nudgePrefix.length);
    if (buttonIndex === 0) {
      void resumeArticle(key);
    } else {
      void dismissNudgesForArticle(key);
    }
    return;
  }
  if (notificationId === NOTIFICATION_IDS.gymReminder) {
    chrome.notifications.clear(notificationId);
    if (buttonIndex === 0) {
      void gymCheckin();
    } else {
      // Snooze 1h; the alarm routes back through fireGymReminder, which
      // re-checks every gate at fire time
      chrome.alarms.create(ALARMS.gymReminderSnooze, { delayInMinutes: 60 });
    }
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === NOTIFICATION_IDS.taskDigest) {
    chrome.notifications.clear(notificationId);
    void chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/popup/index.html') });
    return;
  }
  if (isNudgeNotification(notificationId)) {
    chrome.notifications.clear(notificationId);
    void resumeArticle(notificationId.slice(NOTIFICATION_IDS.nudgePrefix.length));
    return;
  }
  if (isMonitorNotification(notificationId)) {
    chrome.notifications.clear(notificationId);
    // The nudge is already waiting in the assistant chat on the dashboard
    void chrome.tabs.create({ url: chrome.runtime.getURL(NEWTAB_PAGE_PATH) });
    return;
  }
  if (notificationId === NOTIFICATION_IDS.wakeReply) {
    chrome.notifications.clear(notificationId);
    // The exchange is already in the assistant chat on the dashboard
    void openDashboard();
    return;
  }
  if (notificationId === NOTIFICATION_IDS.wakeMicDenied) {
    chrome.notifications.clear(notificationId);
    void chrome.runtime.openOptionsPage();
  }
});
