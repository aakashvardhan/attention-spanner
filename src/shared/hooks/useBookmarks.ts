import { useCallback, useMemo } from 'react';
import { sendMessage } from '../messages';
import type { BookmarkLink } from '../types';
import { useStorageValue } from './useStorageValue';

/**
 * Bookmark links + groups. Writes go through the service worker; both the
 * popup picker and the dashboard panel render from the same storage.
 */
export function useBookmarks() {
  const [bookmarks] = useStorageValue('bookmarks');
  const [groups] = useStorageValue('bookmarkGroups');

  /** groupId (or 'unsorted') → links, groups in creation order, Unsorted last */
  const grouped = useMemo(() => {
    const byGroup = new Map<string, BookmarkLink[]>();
    for (const bookmark of bookmarks) {
      const key = bookmark.groupId ?? 'unsorted';
      const list = byGroup.get(key) ?? [];
      list.push(bookmark);
      byGroup.set(key, list);
    }
    const sections = groups
      .filter((g) => byGroup.has(g.id))
      .map((g) => ({ id: g.id as string | null, name: g.name, links: byGroup.get(g.id)! }));
    if (byGroup.has('unsorted')) {
      sections.push({ id: null, name: 'Unsorted', links: byGroup.get('unsorted')! });
    }
    return sections;
  }, [bookmarks, groups]);

  const addBookmark = useCallback(
    (url: string, title: string, groupId: string | null) =>
      sendMessage({ type: 'ADD_BOOKMARK', url, title, groupId }),
    [],
  );
  const deleteBookmark = useCallback(
    (id: string) => sendMessage({ type: 'DELETE_BOOKMARK', id }),
    [],
  );
  const moveBookmark = useCallback(
    (id: string, groupId: string | null) => sendMessage({ type: 'MOVE_BOOKMARK', id, groupId }),
    [],
  );
  const addGroup = useCallback(
    (name: string) => sendMessage({ type: 'ADD_BOOKMARK_GROUP', name }),
    [],
  );
  const deleteGroup = useCallback(
    (id: string) => sendMessage({ type: 'DELETE_BOOKMARK_GROUP', id }),
    [],
  );

  return { bookmarks, groups, grouped, addBookmark, deleteBookmark, moveBookmark, addGroup, deleteGroup };
}
