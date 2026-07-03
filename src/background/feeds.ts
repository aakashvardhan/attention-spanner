import { ACCENT_COLOR, MAX_READ_ITEMS } from '../shared/constants';
import { getLocal, setLocal } from '../shared/storage';
import { fetchFeed } from './rssParser';
import { registerOpenedTab } from './tracking';

export async function refreshFeeds(): Promise<{ ok: boolean; itemCount: number }> {
  const { feeds } = await getLocal('feeds');

  if (feeds.length === 0) {
    await chrome.action.setBadgeText({ text: '' });
    return { ok: true, itemCount: 0 };
  }

  const results = await Promise.allSettled(feeds.map((url) => fetchFeed(url)));
  const allItems = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  allItems.sort((a, b) => +new Date(b.pubDate) - +new Date(a.pubDate));

  // Keep the previous cache when every feed fails, so a flaky network
  // doesn't wipe the list the user already has.
  if (allItems.length > 0) {
    await setLocal({ cachedItems: allItems, cacheTimestamp: Date.now() });
  }

  await updateBadge();
  return { ok: true, itemCount: allItems.length };
}

export async function updateBadge(): Promise<void> {
  // During a focus session the badge belongs to the countdown, not unread
  // counts. Read focusSession straight from storage — no focus.ts import,
  // so no module cycle.
  const { focusSession } = await getLocal('focusSession');
  if (focusSession) {
    if (focusSession.phase === 'break') {
      await chrome.action.setBadgeText({ text: '☕' });
      await chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
    } else {
      const minutesLeft = Math.max(
        0,
        Math.ceil((focusSession.phaseEndsAt - Date.now()) / 60_000),
      );
      await chrome.action.setBadgeText({ text: String(minutesLeft) });
      await chrome.action.setBadgeBackgroundColor({ color: '#333333' });
    }
    return;
  }

  const { cachedItems, readItems } = await getLocal('cachedItems', 'readItems');
  const unreadCount = cachedItems.filter((item) => !readItems.includes(item.id)).length;
  const badgeText = unreadCount > 99 ? '99+' : unreadCount > 0 ? String(unreadCount) : '';
  await chrome.action.setBadgeText({ text: badgeText });
  await chrome.action.setBadgeBackgroundColor({ color: ACCENT_COLOR });
}

export async function markItemRead(itemId: string): Promise<void> {
  const { readItems } = await getLocal('readItems');
  if (readItems.includes(itemId)) return;
  readItems.push(itemId);
  if (readItems.length > MAX_READ_ITEMS) {
    readItems.splice(0, readItems.length - MAX_READ_ITEMS);
  }
  await setLocal({ readItems });
}

/** Marks everything in the current cache as read — no refetch needed */
export async function markAllRead(): Promise<{ ok: boolean; count: number }> {
  const { cachedItems } = await getLocal('cachedItems');
  const readItems = cachedItems.map((item) => item.id).slice(-MAX_READ_ITEMS);
  await setLocal({ readItems });
  return { ok: true, count: readItems.length };
}

export async function openArticle(
  url: string,
  feedItemId: string | null,
  resume = false,
): Promise<{ ok: boolean }> {
  if (feedItemId) {
    await markItemRead(feedItemId);
  }
  const tab = await chrome.tabs.create({ url });
  if (tab.id !== undefined) {
    await registerOpenedTab(tab.id, url, resume);
  }
  return { ok: true };
}
