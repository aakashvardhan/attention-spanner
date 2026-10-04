import { NEWTAB_PAGE_PATH, NOTIFICATION_IDS } from '../shared/constants';
import { migrate } from '../shared/storage';
import { setLocalDispatcher, type Message } from '../shared/messages';
import type { Settings } from '../shared/types';
import { clearRetiredAlarms, handleAlarm, setupRefreshAlarm } from './alarms';
import { bookmarkFromContextMenu } from './bookmarks';
import { checkDrift } from './drift';
import { openArticle, refreshFeeds, updateBadge } from './feeds';
import { reconcileFocusOnStartup, refreshFocusRules } from './focus';
import { removeLegacyDailyGateRule } from './accessRules';
import {
  dismissNudgesForArticle,
  isNudgeNotification,
  resumeArticle,
} from './nudges';
import { markPaperReadingByUrl } from './papers';
import { maybeInterceptPdf, maybeInterceptPdfResponse } from './pdfIntercept';
import { refreshTimedtextTees, registerTimedtextTee } from './videoContext';
import { handleTabRemoved, maybeInjectTracker } from './tracking';
import { maybeInjectVideoTracker } from './videoTracking';
import { dispatch, handleMessage } from './router';

/**
 * MV3 service worker entry. Every listener is registered synchronously at
 * top level; no module-level mutable state — handlers rehydrate from storage.
 */

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
    await clearRetiredAlarms();
    await setupRefreshAlarm();
    await removeLegacyDailyGateRule();
    await reconcileFocusOnStartup();
    // onInstalled also fires on extension reloads — clear before re-creating
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: 'read-in-reader',
      title: 'Read in Reader',
      contexts: ['page', 'link'],
    });
    chrome.contextMenus.create({
      id: 'bookmark-link',
      // Was "Bookmark in Reader", which promised the reader and only bookmarked
      title: 'Bookmark this page',
      contexts: ['page', 'link'],
    });
    await refreshFeeds();
    // This reload just orphaned every content script already running
    await reinjectIntoOpenTabs();
    await registerTimedtextTee();
  })();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'bookmark-link') {
    void bookmarkFromContextMenu(info, tab);
    return;
  }
  if (info.menuItemId === 'read-in-reader') {
    const url = info.linkUrl ?? info.pageUrl;
    if (url && /^https?:/.test(url)) void openArticle(url, null, false, true);
  }
});

chrome.runtime.onStartup.addListener(() => {
  void updateBadge();
  // MV3 alarms normally survive a restart, but nothing else re-creates this
  // one if it is ever lost — and losing it silently stops all feed refreshes.
  void setupRefreshAlarm();
  void (async () => {
    await removeLegacyDailyGateRule();
    await reconcileFocusOnStartup();
  })();
  // Caption capture depends on the tee being present before the player boots
  void registerTimedtextTee();
  // Restored session tabs come back without their content scripts
  void reinjectIntoOpenTabs();
});

chrome.alarms.onAlarm.addListener(handleAlarm);

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) =>
  handleMessage(msg, sender, sendResponse),
);

// sendMessage from the SW itself never reaches the listener above — register
// the router as the in-process dispatcher so tools are runnable here too
// (agent runs, automations). Pages/offscreen keep the runtime path.
setLocalDispatcher((msg) => dispatch(msg, {} as chrome.runtime.MessageSender));

// Clicking the toolbar icon opens the dashboard. It used to open the side panel
// via setPanelBehavior; with the panel gone the new tab is the only surface, so
// the icon is a destination again. There is still no popup — see the note in
// manifest.config.ts for why.
//
// Explicitly the extension's own page rather than a bare tabs.create({}): if
// another extension has taken the new tab override, an empty create would open
// theirs, and the toolbar icon has to land on ours.
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL(NEWTAB_PAGE_PATH) });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'read-this-page') {
    // Opens a new tab rather than replacing this one on purpose: the reader
    // re-fetches the URL from the extension origin, which an app-shell page can
    // defeat, and leaving the original open makes that recoverable.
    if (tab?.url && /^https?:/.test(tab.url)) {
      void openArticle(tab.url, null, false, true);
    }
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  // Badge is derived state — recompute whenever its inputs change
  // (focusSession flips it between countdown and resumable-count modes)
  if (changes.readingProgress || changes.papers || changes.focusSession) {
    void updateBadge();
  }

  // Re-arm alarms when their intervals change
  if (changes.settings) {
    const oldSettings = (changes.settings.oldValue ?? {}) as Partial<Settings>;
    const newSettings = (changes.settings.newValue ?? {}) as Partial<Settings>;
    if (oldSettings.refreshInterval !== newSettings.refreshInterval) {
      void setupRefreshAlarm(newSettings.refreshInterval);
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
  // PDF navigations bounce into the in-extension reader (unless bypassed).
  // Checked first so the trackers below never run against a soon-gone page.
  if (changeInfo.url) {
    void maybeInterceptPdf(tabId, changeInfo.url);
  }
  if (changeInfo.status === 'complete' && tab.url) {
    void maybeInjectTracker(tabId, tab.url);
    // URL-only match — works even in PDF viewers our content scripts can't enter
    void markPaperReadingByUrl(tab.url);
    void checkDrift(tab);
  }
  // YouTube is an SPA: pushState navs fire onUpdated with changeInfo.url but
  // no 'complete'. The in-page guard makes repeated injections harmless.
  const navUrl = changeInfo.url ?? (changeInfo.status === 'complete' ? tab.url : undefined);
  if (navUrl) {
    void maybeInjectVideoTracker(tabId, navUrl);
  }
});

// The daily gate is gone, but rule 900 is a DYNAMIC DNR rule: profiles that
// ever ran the old browser-wide redirect still carry it, and it survives
// restarts and updates. Nothing else removes it, and onStartup does not fire
// for ordinary MV3 worker restarts — so every worker instance sweeps it.
// Cheap: one getDynamicRules that early-returns when there is nothing to drop.
void removeLegacyDailyGateRule();

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

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.get(tabId).then(checkDrift, () => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleTabRemoved(tabId);
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (isNudgeNotification(notificationId)) {
    chrome.notifications.clear(notificationId);
    const key = notificationId.slice(NOTIFICATION_IDS.nudgePrefix.length);
    if (buttonIndex === 0) {
      void resumeArticle(key);
    } else {
      void dismissNudgesForArticle(key);
    }
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (isNudgeNotification(notificationId)) {
    chrome.notifications.clear(notificationId);
    void resumeArticle(notificationId.slice(NOTIFICATION_IDS.nudgePrefix.length));
  }
});
