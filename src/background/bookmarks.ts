import { MAX_BOOKMARKS, NOTIFICATION_IDS } from '../shared/constants';
import { getLocal, getSettings, setLocal } from '../shared/storage';
import type { BookmarkGroup, BookmarkLink } from '../shared/types';

/**
 * Curated bookmark links + groups. All writes serialized in the service
 * worker like tasks/notes; the dashboard and popup render from storage.
 */

export async function addBookmark(
  url: string,
  title: string,
  groupId: string | null,
): Promise<BookmarkLink> {
  const { bookmarks } = await getLocal('bookmarks');

  // Re-adding an existing URL updates it instead of duplicating
  const existing = bookmarks.find((b) => b.url === url);
  if (existing) {
    if (title.trim()) existing.title = title.trim();
    existing.groupId = groupId;
    await setLocal({ bookmarks });
    return existing;
  }

  let fallbackTitle = url;
  try {
    fallbackTitle = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // keep the raw url as title fallback
  }
  const bookmark: BookmarkLink = {
    id: crypto.randomUUID(),
    url,
    title: title.trim() || fallbackTitle,
    groupId,
    createdAt: Date.now(),
  };
  bookmarks.unshift(bookmark);
  if (bookmarks.length > MAX_BOOKMARKS) bookmarks.length = MAX_BOOKMARKS;
  await setLocal({ bookmarks });
  return bookmark;
}

export async function deleteBookmark(id: string): Promise<void> {
  const { bookmarks } = await getLocal('bookmarks');
  await setLocal({ bookmarks: bookmarks.filter((b) => b.id !== id) });
}

export async function moveBookmark(id: string, groupId: string | null): Promise<void> {
  const { bookmarks } = await getLocal('bookmarks');
  const bookmark = bookmarks.find((b) => b.id === id);
  if (!bookmark) return;
  bookmark.groupId = groupId;
  await setLocal({ bookmarks });
}

/** Case-insensitive name dedupe: adding an existing group returns it */
export async function addBookmarkGroup(name: string): Promise<BookmarkGroup> {
  const trimmed = name.trim();
  const { bookmarkGroups } = await getLocal('bookmarkGroups');
  const existing = bookmarkGroups.find(
    (g) => g.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (existing) return existing;

  const group: BookmarkGroup = { id: crypto.randomUUID(), name: trimmed, createdAt: Date.now() };
  bookmarkGroups.push(group);
  await setLocal({ bookmarkGroups });
  return group;
}

/** Links in the deleted group fall back to Unsorted, never deleted */
export async function deleteBookmarkGroup(id: string): Promise<void> {
  const { bookmarkGroups, bookmarks } = await getLocal('bookmarkGroups', 'bookmarks');
  let changed = false;
  for (const bookmark of bookmarks) {
    if (bookmark.groupId === id) {
      bookmark.groupId = null;
      changed = true;
    }
  }
  await setLocal({
    bookmarkGroups: bookmarkGroups.filter((g) => g.id !== id),
    ...(changed ? { bookmarks } : {}),
  });
}

/** Context-menu save: land in Unsorted, confirm with a notification */
export async function bookmarkFromContextMenu(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): Promise<void> {
  const url = info.linkUrl ?? info.pageUrl;
  if (!url || !/^https?:/.test(url)) return;
  // For links use the selected text if any; for pages use the tab title
  const title = info.linkUrl ? (info.selectionText ?? '') : (tab?.title ?? '');
  const bookmark = await addBookmark(url, title, null);

  const settings = await getSettings();
  if (settings.notificationsEnabled) {
    chrome.notifications.create(NOTIFICATION_IDS.bookmarkSaved, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: 'Bookmarked 🔖',
      message: `"${bookmark.title}" saved — group it on your dashboard.`,
      priority: 0,
    });
  }
}
