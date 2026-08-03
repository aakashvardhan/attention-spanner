import { getLocal, setLocal } from '../shared/storage';
import type { XBookmark } from '../shared/types';

const MAX_X_BOOKMARKS = 500;
const X_BOOKMARKS_URL = 'https://x.com/i/bookmarks';

export function isXBookmarksUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      (url.hostname === 'x.com' || url.hostname === 'www.x.com' ||
        url.hostname === 'twitter.com' || url.hostname === 'www.twitter.com') &&
      url.pathname.startsWith('/i/bookmarks')
    );
  } catch {
    return false;
  }
}

/** Merge newly visible tweets without dropping bookmarks that were not loaded in the page yet. */
export function mergeXBookmarks(existing: XBookmark[], incoming: XBookmark[]): XBookmark[] {
  const byId = new Map(existing.map((bookmark) => [bookmark.id, bookmark]));
  for (const bookmark of incoming) {
    const previous = byId.get(bookmark.id);
    byId.set(bookmark.id, previous ? { ...previous, ...bookmark } : bookmark);
  }
  return [...byId.values()]
    .sort((a, b) => b.capturedAt - a.capturedAt)
    .slice(0, MAX_X_BOOKMARKS);
}

export async function saveVisibleXBookmarks(items: XBookmark[]): Promise<number> {
  const { xBookmarks } = await getLocal('xBookmarks');
  const now = Date.now();
  const safeItems = items.slice(0, 100).flatMap((item): XBookmark[] => {
    if (!/^\d+$/.test(item.id)) return [];
    try {
      const url = new URL(item.url);
      const match = url.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);
      if (!match || match[2] !== item.id || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)) return [];
      const handle = match[1];
      return [{
        id: item.id,
        url: `https://x.com/${handle}/status/${item.id}`,
        text: typeof item.text === 'string' ? item.text.slice(0, 10_000) : '',
        authorName: typeof item.authorName === 'string' ? item.authorName.slice(0, 200) : handle,
        authorHandle: `@${handle}`,
        postedAt: typeof item.postedAt === 'number' && Number.isFinite(item.postedAt) ? item.postedAt : null,
        capturedAt: now,
      }];
    } catch {
      return [];
    }
  });
  const merged = mergeXBookmarks(xBookmarks, safeItems);
  await setLocal({ xBookmarks: merged, xBookmarksLastSyncedAt: Date.now() });
  return merged.length;
}

export async function openXBookmarks(): Promise<void> {
  const [existing] = await chrome.tabs.query({ url: ['https://x.com/i/bookmarks*', 'https://twitter.com/i/bookmarks*'] });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: X_BOOKMARKS_URL });
}

export async function maybeInjectXBookmarks(tabId: number, url: string): Promise<void> {
  if (!isXBookmarksUrl(url)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/xBookmarks.js'] });
  } catch (error) {
    console.warn('[x-bookmarks] injection failed', error);
  }
}
