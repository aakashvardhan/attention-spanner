import { ALARMS, CAPTURE_WINDOW_TASK, NOTIFICATION_IDS } from '../shared/constants';
import { migrate } from '../shared/storage';
import type { Message } from '../shared/messages';
import type { Settings } from '../shared/types';
import {
  handleAlarm,
  setupGymReminderAlarm,
  setupRefreshAlarm,
  setupTaskReminderAlarm,
} from './alarms';
import { bookmarkFromContextMenu } from './bookmarks';
import { refreshFeeds, updateBadge } from './feeds';
import { reconcileFocusOnStartup, refreshFocusRules } from './focus';
import { gymCheckin, recomputeGymStreak } from './gym';
import {
  dismissNudgesForArticle,
  isNudgeNotification,
  resumeArticle,
} from './nudges';
import { recomputeStreak } from './streaks';
import { pruneCompletedTasks, snoozeOpenTasks } from './tasks';
import { maybeInjectTimePill } from './timePill';
import { markPaperReadingByUrl } from './papers';
import { handleTabRemoved, maybeInjectTracker } from './tracking';
import { maybeInjectVideoTracker } from './videoTracking';
import { handleMessage } from './router';

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
    await reconcileFocusOnStartup();
    // Extension updates can land mid-gap; recompute so stale streaks don't
    // display until the next browser restart
    await recomputeStreak();
    await recomputeGymStreak();
    // onInstalled also fires on extension reloads — clear before re-creating
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: 'bookmark-link',
      title: 'Bookmark in Reader',
      contexts: ['page', 'link'],
    });
    await refreshFeeds();
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
  // Re-anchor the daily reminder to the wall clock (bounds DST drift)
  void setupGymReminderAlarm();
  void reconcileFocusOnStartup();
});

chrome.alarms.onAlarm.addListener(handleAlarm);

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) =>
  handleMessage(msg, sender, sendResponse),
);

chrome.commands.onCommand.addListener((command) => {
  if (command === 'quick-capture-task') {
    void openCaptureWindow();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  // Badge is derived state — recompute whenever its inputs change
  // (focusSession flips it between countdown and unread-count modes)
  if (changes.cachedItems || changes.readItems || changes.focusSession) {
    void updateBadge();
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
    // Arrays need a structural compare, unlike the scalar settings above
    if (
      JSON.stringify(oldSettings.focusBlocklist) !== JSON.stringify(newSettings.focusBlocklist) &&
      newSettings.focusBlocklist
    ) {
      void refreshFocusRules(newSettings.focusBlocklist);
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
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
  }
});
