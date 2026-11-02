import { logActivity } from '../shared/activity';
import { BLOCKED_PAGE_PATH, READER_PAGE_PATH } from '../shared/constants';
import { isBlockedHost, withReaderTab, withoutReaderTab } from '../shared/focusRules';
import { getLocal, getSettings, setLocal } from '../shared/storage';
import { syncSessionAccessRules } from './accessRules';

/**
 * The reading session: while any reader tab is open, the blocklist redirects
 * to the blocked page (DNR session rules, enforced by the browser even when
 * this worker sleeps). storage.local focusSession is the source of truth; the
 * rules are reconciled from it on every change and on startup.
 */

function blockedPageUrl(): string {
  return chrome.runtime.getURL(BLOCKED_PAGE_PATH);
}

/** An already-open blocked tab would defeat the whole point */
export async function redirectOpenBlockedTabs(domains: string[]): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (tab.id === undefined || !tab.url) continue;
    try {
      if (isBlockedHost(new URL(tab.url).hostname, domains)) {
        await chrome.tabs.update(tab.id, { url: `${blockedPageUrl()}#${tab.url}` });
      }
    } catch {
      // unparseable URL: skip
    }
  }
}

export function isReaderUrl(url: string | undefined): boolean {
  return !!url && url.startsWith(chrome.runtime.getURL(READER_PAGE_PATH));
}

/** The reader page announces itself; the first one starts the session. */
export async function readerOpened(tabId: number, title: string): Promise<{ ok: boolean }> {
  const { focusSession } = await getLocal('focusSession');
  const starting = !focusSession;
  await setLocal({ focusSession: withReaderTab(focusSession, tabId, title, Date.now()) });
  await syncSessionAccessRules();
  if (starting) await redirectOpenBlockedTabs((await getSettings()).focusBlocklist);
  return { ok: true };
}

/** A reader tab closed or left the reader; the last one ends the session. */
export async function readerClosed(tabId: number): Promise<void> {
  const { focusSession } = await getLocal('focusSession');
  if (!focusSession?.tabIds.includes(tabId)) return;
  const next = withoutReaderTab(focusSession, tabId);
  await setLocal({ focusSession: next });
  if (!next) {
    // A finished reading session is the heatmap's "focus" square, and its minutes.
    await logActivity({ focus: true });
    await logActivity({ clocked: Math.round((Date.now() - focusSession.startedAt) / 60_000) });
  }
  await syncSessionAccessRules();
}

/** The blocked page's "Back to your paper": bring the reader tab forward. */
export async function focusReader(): Promise<{ ok: boolean }> {
  const { focusSession } = await getLocal('focusSession');
  const tabId = focusSession?.tabIds.at(-1);
  if (tabId === undefined) return { ok: false };
  const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
  if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  return { ok: !!tab };
}

/**
 * Startup: tab ids do not survive a browser restart, so drop every id that no
 * longer points at an open reader tab. Rules must never outlive state.
 */
export async function reconcileFocusOnStartup(): Promise<void> {
  const { focusSession } = await getLocal('focusSession');
  let next = focusSession;
  for (const id of focusSession?.tabIds ?? []) {
    const tab = await chrome.tabs.get(id).catch(() => undefined);
    if (!isReaderUrl(tab?.url)) next = withoutReaderTab(next, id);
  }
  if (next !== focusSession) await setLocal({ focusSession: next });
  await syncSessionAccessRules();
}

/** Blocklist edited mid-session: refresh rules if currently blocking */
export async function refreshFocusRules(newBlocklist: string[]): Promise<void> {
  const { focusSession } = await getLocal('focusSession');
  if (!focusSession) return;
  await syncSessionAccessRules();
  await redirectOpenBlockedTabs(newBlocklist);
}
