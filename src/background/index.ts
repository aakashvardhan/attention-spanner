import { NEWTAB_PAGE_PATH } from '../shared/constants';
import { migrate } from '../shared/storage';
import { setLocalDispatcher, type Message } from '../shared/messages';
import type { Settings } from '../shared/types';
import { clearRetiredAlarms } from './alarms';
import { SYNC_ALARM, syncLibrary } from './alphaxiv';
import { isReaderUrl, readerClosed, reconcileFocusOnStartup, refreshFocusRules } from './focus';
import { removeLegacyDailyGateRule } from './accessRules';
import { syncPdfRules } from './pdfIntercept';
import { dispatch, handleMessage } from './router';

/**
 * MV3 service worker entry. Every listener is registered synchronously at
 * top level; no module-level mutable state: handlers rehydrate from storage.
 */

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await migrate();
    await clearRetiredAlarms();
    await removeLegacyDailyGateRule();
    await reconcileFocusOnStartup();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await removeLegacyDailyGateRule();
    await reconcileFocusOnStartup();
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) void syncLibrary();
});

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) =>
  handleMessage(msg, sender, sendResponse),
);

// sendMessage from the SW itself never reaches the listener above: register
// the router as the in-process dispatcher.
setLocalDispatcher((msg) => dispatch(msg, {} as chrome.runtime.MessageSender));

// The toolbar icon opens our own new tab (not a bare tabs.create, which could
// land on another extension's override).
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL(NEWTAB_PAGE_PATH) });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const oldSettings = (changes.settings.oldValue ?? {}) as Partial<Settings>;
  const newSettings = (changes.settings.newValue ?? {}) as Partial<Settings>;
  if (
    JSON.stringify(oldSettings.focusBlocklist) !== JSON.stringify(newSettings.focusBlocklist) &&
    newSettings.focusBlocklist
  ) {
    void refreshFocusRules(newSettings.focusBlocklist);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  // A reader tab that navigates elsewhere has left the reading session.
  if (!isReaderUrl(changeInfo.url)) void readerClosed(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void readerClosed(tabId);
});

// Rule 900 (the retired daily gate) is a DYNAMIC rule that survives updates;
// every worker instance sweeps it. Cheap when there is nothing to drop.
void removeLegacyDailyGateRule();

// Session rules outlive the worker but not the browser; rebuild on every start.
void syncPdfRules();
