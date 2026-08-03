import { useEffect, useState } from 'react';

/**
 * The tab the panel is currently sitting beside, kept current.
 *
 * A popup could read the active tab once on mount and be right for its whole
 * (very short) life. The side panel outlives the tab it opened on — switch tabs
 * and it stays put — so a one-shot query goes stale and you end up bookmarking
 * or recording whatever you were looking at five minutes ago. Hence the
 * listeners: activation for tab switches, updated for in-place navigation and
 * late-arriving titles, focus for moving between windows.
 */
export function useActiveTab(): chrome.tabs.Tab | null {
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);

  useEffect(() => {
    let live = true;
    const refresh = () => {
      void chrome.tabs.query({ active: true, currentWindow: true }).then(([current]) => {
        if (live) setTab(current ?? null);
      });
    };

    refresh();
    const onUpdated = (_id: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      // Every tab in every window fires this; only url/title move the panel
      if (changeInfo.url !== undefined || changeInfo.title !== undefined) refresh();
    };
    chrome.tabs.onActivated.addListener(refresh);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onFocusChanged.addListener(refresh);

    return () => {
      live = false;
      chrome.tabs.onActivated.removeListener(refresh);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows.onFocusChanged.removeListener(refresh);
    };
  }, []);

  return tab;
}
