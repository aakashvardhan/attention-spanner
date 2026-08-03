import { useState } from 'react';
import { useActiveTab } from '../../../shared/hooks/useActiveTab';
import { useBookmarks } from '../../../shared/hooks/useBookmarks';

/**
 * Compact bookmark-current-tab row shown inside the panel Actions menu: pick a group
 * chip (or create one inline) and the active tab is saved.
 */
export function BookmarkPicker({ onDone }: { onDone: () => void }) {
  const { groups, addBookmark, addGroup } = useBookmarks();
  const active = useActiveTab();
  const [newGroup, setNewGroup] = useState('');
  const [saved, setSaved] = useState(false);

  const tab =
    active?.url && /^https?:/.test(active.url)
      ? { url: active.url, title: active.title ?? active.url }
      : null;

  const save = async (groupId: string | null) => {
    if (!tab || saved) return;
    setSaved(true);
    await addBookmark(tab.url, tab.title, groupId);
    setTimeout(onDone, 500);
  };

  const saveToNewGroup = async () => {
    if (!tab || !newGroup.trim() || saved) return;
    const res = await addGroup(newGroup.trim());
    await save(res.group.id);
  };

  if (!tab) {
    return (
      <div className="bookmark-picker">
        <span className="bookmark-picker-title">This page can't be bookmarked.</span>
      </div>
    );
  }

  return (
    <div className="bookmark-picker">
      <span className="bookmark-picker-title" title={tab.title}>
        {saved ? 'Bookmarked' : `Bookmark: ${tab.title}`}
      </span>
      {!saved && (
        <div className="bookmark-picker-groups">
          {groups.map((group) => (
            <button key={group.id} className="bookmark-chip" onClick={() => void save(group.id)}>
              {group.name}
            </button>
          ))}
          <button className="bookmark-chip" onClick={() => void save(null)}>
            Unsorted
          </button>
          <form
            className="bookmark-newgroup"
            onSubmit={(e) => {
              e.preventDefault();
              void saveToNewGroup();
            }}
          >
            <input
              type="text"
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              placeholder="＋ new group"
              maxLength={40}
            />
          </form>
        </div>
      )}
    </div>
  );
}
