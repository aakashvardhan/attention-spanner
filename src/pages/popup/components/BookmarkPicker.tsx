import { useEffect, useState } from 'react';
import { useBookmarks } from '../../../shared/hooks/useBookmarks';

/**
 * Compact bookmark-current-tab row shown under the FocusBar: pick a group
 * chip (or create one inline) and the active tab is saved.
 */
export function BookmarkPicker({ onDone }: { onDone: () => void }) {
  const { groups, addBookmark, addGroup } = useBookmarks();
  const [tab, setTab] = useState<{ url: string; title: string } | null>(null);
  const [newGroup, setNewGroup] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([active]) => {
      if (active?.url && /^https?:/.test(active.url)) {
        setTab({ url: active.url, title: active.title ?? active.url });
      }
    });
  }, []);

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
        {saved ? '✓ Bookmarked!' : `🔖 ${tab.title}`}
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
