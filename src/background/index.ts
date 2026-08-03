import { cacheInvalidateTag } from '../shared/ai/cache';
import { CAPTURE_WINDOW_TASK, NEWTAB_PAGE_PATH, NOTIFICATION_IDS } from '../shared/constants';
import { migrate } from '../shared/storage';
import { setLocalDispatcher, type Message } from '../shared/messages';
import type { Settings } from '../shared/types';
import {
  handleAlarm,
  setupAutomationAlarms,
  setupCalendarRefreshAlarm,
  setupGmailTriageAlarm,
  setupMonitorAlarms,
  setupRefreshAlarm,
  setupTaskReminderAlarm,
} from './alarms';
import { refreshCalendar } from './calendar';
import { bookmarkFromContextMenu } from './bookmarks';
import { refreshFeeds, updateBadge } from './feeds';
import { reconcileFocusOnStartup, refreshFocusRules } from './focus';
import {
  ensureDailyGateDateForNavigation,
  reconcileDailyBrainDump,
} from './dailyBrainDump';
import {
  dismissNudgesForArticle,
  isNudgeNotification,
  resumeArticle,
} from './nudges';
import { isMonitorNotification } from './monitor';
import { recomputeStreak } from './streaks';
import { pruneCompletedTasks, snoozeOpenTasks } from './tasks';
import { maybeInjectTimePill } from './timePill';
import { toggleCopilotOverlay } from './copilotOverlay';
import { markPaperReadingByUrl } from './papers';
import { maybeInterceptPdf, maybeInterceptPdfResponse } from './pdfIntercept';
import { openDashboard, syncWakeWordListener } from './offscreen';
import { reconcileRecordings, refreshTimedtextTees, registerTimedtextTee } from './recordings';
import { handleTabRemoved, maybeInjectTracker } from './tracking';
import { maybeInjectVideoTracker } from './videoTracking';
import { maybeInjectXBookmarks } from './xBookmarks';
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

/**
 * Re-inject the content scripts into tabs that are already open. A reload or
 * update orphans every running instance, and a tab the user is simply sitting
 * on never fires onUpdated again — so without this, tracking stays dead until
 * they happen to navigate. The injectors self-filter by URL, and the in-page
 * guards evict only orphans, so a live script is left running untouched.
 */
async function reinjectIntoOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all([
    ...tabs.flatMap((tab) =>
      tab.id !== undefined && tab.url
        ? [
            maybeInjectTracker(tab.id, tab.url),
            maybeInjectVideoTracker(tab.id, tab.url),
            maybeInjectTimePill(tab.id, tab.url),
            maybeInjectXBookmarks(tab.id, tab.url),
          ]
        : [],
    ),
    // The MAIN-world tee cannot self-evict (no chrome.runtime there), so its
    // orphans have to be unwound from this side.
    refreshTimedtextTees(),
  ]);
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await migrate();
    await setupRefreshAlarm();
    await setupTaskReminderAlarm();
    await setupCalendarRefreshAlarm();
    await setupMonitorAlarms();
    await setupGmailTriageAlarm();
    await setupAutomationAlarms();
    await reconcileDailyBrainDump({ redirectTabs: true, restoreCompletedRedirects: true });
    await reconcileFocusOnStartup();
    // Extension updates can land mid-gap; recompute so stale streaks don't
    // display until the next browser restart
    await recomputeStreak();
    // onInstalled also fires on extension reloads — clear before re-creating
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: 'bookmark-link',
      title: 'Bookmark in Reader',
      contexts: ['page', 'link'],
    });
    await refreshFeeds();
    // This reload just orphaned every content script already running
    await reinjectIntoOpenTabs();
    // Resume cloud sync if signed in (inert until a transport is registered)
    await initSync();
    await syncWakeWordListener();
    await registerTimedtextTee();
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
  // MV3 alarms normally survive a restart, but nothing else re-creates this
  // one if it is ever lost — and losing it silently stops all feed refreshes.
  void setupRefreshAlarm();
  // Re-anchor the daily reminders to the wall clock (bounds DST drift)
  void setupMonitorAlarms();
  void setupGmailTriageAlarm();
  void setupAutomationAlarms();
  void (async () => {
    await reconcileDailyBrainDump({ redirectTabs: true, restoreCompletedRedirects: true });
    await reconcileFocusOnStartup();
  })();
  // A recording in flight died with the browser; settle whatever it transcribed
  void reconcileRecordings();
  // Caption capture depends on the tee being present before the player boots
  void registerTimedtextTee();
  // Restored session tabs come back without their content scripts
  void reinjectIntoOpenTabs();
  void refreshCalendar();
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

// Clicking the toolbar icon opens the side panel. This is a stored preference
// rather than a manifest field, so it has to be re-asserted from the worker;
// top-level (not onInstalled) so a profile that predates the change picks it up
// on the next wake too.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
  console.error('[sidePanel] could not open on action click', error);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'quick-capture-task') {
    void openCaptureWindow();
  } else if (command === 'toggle-copilot') {
    // sidePanel.open needs a user gesture and a commands handler counts as one,
    // but only while the call stays on this synchronous path — awaiting a tab
    // lookup first would spend the gesture and throw.
    if (tab?.id !== undefined) {
      void chrome.sidePanel.open({ tabId: tab.id }).catch((error) => {
        console.error('[commands] could not open the side panel', error);
      });
    }
  } else if (command === 'toggle-overlay') {
    if (tab?.id !== undefined) void toggleCopilotOverlay(tab.id, tab.url ?? '');
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
    if (oldSettings.monitorEveningTime !== newSettings.monitorEveningTime) {
      void setupMonitorAlarms(newSettings.monitorEveningTime);
    }
    if (oldSettings.gmailTriageTime !== newSettings.gmailTriageTime) {
      void setupGmailTriageAlarm(newSettings.gmailTriageTime);
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
    if (changeInfo.url.startsWith('http://') || changeInfo.url.startsWith('https://')) {
      void ensureDailyGateDateForNavigation();
    }
    void maybeInterceptPdf(tabId, changeInfo.url);
  }
  if (changeInfo.status === 'complete' && tab.url) {
    void maybeInjectTracker(tabId, tab.url);
    void maybeInjectTimePill(tabId, tab.url);
    void maybeInjectXBookmarks(tabId, tab.url);
    // URL-only match — works even in PDF viewers our content scripts can't enter
    void markPaperReadingByUrl(tab.url);
  }
  // YouTube is an SPA: pushState navs fire onUpdated with changeInfo.url but
  // no 'complete'. The in-page guard makes repeated injections harmless.
  const navUrl = changeInfo.url ?? (changeInfo.status === 'complete' ? tab.url : undefined);
  if (navUrl) {
    void maybeInjectVideoTracker(tabId, navUrl);
    // X is an SPA; navigating to Bookmarks may not produce a completed load.
    void maybeInjectXBookmarks(tabId, navUrl);
  }
});

// Every service-worker instance reasserts the persistent redirect and the
// session unlock. onStartup does not fire for ordinary MV3 worker restarts.
void reconcileDailyBrainDump();

// PDFs served from an extensionless URL (allenai.org/papers/…) look like an
// ordinary page until the response headers arrive; this is the only way to see
// them before Chrome's own viewer takes the tab. Observation only — no blocking.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    void maybeInterceptPdfResponse(details);
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
  ['responseHeaders'],
);

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleTabRemoved(tabId);
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (notificationId === NOTIFICATION_IDS.taskDigest) {
    chrome.notifications.clear(notificationId);
    if (buttonIndex === 0) {
      void snoozeOpenTasks(60 * 60 * 1000);
    } else {
      // The side panel would be the closer match, but sidePanel.open needs a
      // user gesture that a notification callback does not supply — the
      // dashboard's task card is the surface that opens reliably from here.
      void chrome.tabs.create({ url: chrome.runtime.getURL(NEWTAB_PAGE_PATH) });
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
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === NOTIFICATION_IDS.taskDigest) {
    chrome.notifications.clear(notificationId);
    void chrome.tabs.create({ url: chrome.runtime.getURL(NEWTAB_PAGE_PATH) });
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
