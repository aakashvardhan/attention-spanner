import { type CSSProperties, useState } from 'react';
import { faviconUrl } from '../../shared/format';
import { useBookmarks } from '../../shared/hooks/useBookmarks';
import { sendMessage } from '../../shared/messages';

export function normalizeBookmarkUrl(value: string): string | null {
  const candidate = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
  if (candidate === 'https://') return null;

  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function BookmarksPanel() {
  const bookmarks = useBookmarks();
  const [editing, setEditing] = useState(false);
  // The add form is a rare action, so it stays folded until asked for.
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [groupChoice, setGroupChoice] = useState('unsorted');
  const [newGroupName, setNewGroupName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    const normalized = normalizeBookmarkUrl(url);
    if (!normalized) {
      setError('Enter a valid web address.');
      return;
    }

    let groupId: string | null = groupChoice === 'unsorted' ? null : groupChoice;
    if (groupChoice === 'new') {
      const name = newGroupName.trim();
      if (!name) {
        setError('Name the new group first.');
        return;
      }
      const response = await bookmarks.addGroup(name);
      groupId = response.group.id;
      setGroupChoice(response.group.id);
      setNewGroupName('');
    }

    await bookmarks.addBookmark(normalized, title.trim(), groupId);
    setUrl('');
    setTitle('');
    setError(null);
  };

  return (
    <section className="edition-favorites" aria-labelledby="bookmark-links-title">
      <h2 id="bookmark-links-title" className="edition-kicker">Favorites</h2>

      {bookmarks.grouped.length === 0 && (
        <p className="edition-fav-empty">
          None yet. Add one, or right-click any page and choose “Bookmark this page”.
        </p>
      )}
      {bookmarks.grouped.map((group) => (
        <div key={group.id ?? 'unsorted'} className="edition-fav-group">
          {/* One unnamed group needs no label; with several, the name says which is which. */}
          {bookmarks.grouped.length > 1 && <span className="edition-fav-group-name">{group.name}</span>}
          {editing && group.id !== null && (
            <button
              type="button"
              className="edition-link"
              aria-label={`Delete ${group.name} group`}
              onClick={() => {
                if (window.confirm(`Delete group "${group.name}"? Its links will move to Unsorted.`)) {
                  void bookmarks.deleteGroup(group.id!);
                }
              }}
            >
              Delete group
            </button>
          )}
          <ul className="edition-fav-list">
            {group.links.map((link) => (
              <li key={link.id}>
                {/* The href stays so middle-click, modifier-click and "open in
                    new tab" keep working; a plain left click is the one we
                    reroute. A bookmark opens the page itself, not the
                    reader: it is somewhere you go (openArticle). */}
                <a
                  className="edition-fav"
                  href={link.url}
                  title={link.url}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
                      return;
                    }
                    event.preventDefault();
                    void sendMessage({
                      type: 'OPEN_ARTICLE',
                      url: link.url,
                      feedItemId: null,
                      readerView: false,
                    });
                  }}
                >
                  <BookmarkIcon url={link.url} title={link.title} />
                  <span>{link.title}</span>
                </a>
                {editing && (
                  <span className="edition-fav-edit">
                    <select
                      aria-label={`Move ${link.title}`}
                      value={link.groupId ?? 'unsorted'}
                      onChange={(event) =>
                        void bookmarks.moveBookmark(
                          link.id,
                          event.target.value === 'unsorted' ? null : event.target.value,
                        )
                      }
                    >
                      {bookmarks.groups.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                      ))}
                      <option value="unsorted">Unsorted</option>
                    </select>
                    <button
                      type="button"
                      className="edition-link"
                      aria-label={`Delete ${link.title}`}
                      onClick={() => void bookmarks.deleteBookmark(link.id)}
                    >
                      Delete
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      <button type="button" className="edition-link" aria-expanded={adding} onClick={() => setAdding((current) => !current)}>
        {adding ? 'Cancel' : '+ Add'}
      </button>
      {bookmarks.bookmarks.length > 0 && (
        <button type="button" className="edition-link" aria-pressed={editing} onClick={() => setEditing((current) => !current)}>
          {editing ? 'Done' : 'Edit'}
        </button>
      )}

      {adding && (
        <form
          className="bm-add"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <input
            type="text"
            inputMode="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="Paste a URL…"
            autoFocus
            aria-label="Bookmark URL"
          />
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Name (optional)"
            aria-label="Bookmark name"
          />
          <div className="bm-add-row">
            <select
              value={groupChoice}
              onChange={(event) => setGroupChoice(event.target.value)}
              aria-label="Bookmark group"
            >
              {bookmarks.groups.map((group) => (
                <option key={group.id} value={group.id}>{group.name}</option>
              ))}
              <option value="unsorted">Unsorted</option>
              <option value="new">New group…</option>
            </select>
            {groupChoice === 'new' && (
              <input
                type="text"
                value={newGroupName}
                onChange={(event) => setNewGroupName(event.target.value)}
                placeholder="Group name"
                aria-label="New bookmark group name"
                maxLength={40}
              />
            )}
            <button type="submit" className="bm-add-btn" disabled={!url.trim()}>
              Add
            </button>
          </div>
          {error && <p className="bm-error" role="alert">{error}</p>}
        </form>
      )}
    </section>
  );
}

function BookmarkIcon({ url, title }: { url: string; title: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="bm-letter" style={{ '--bm-hue': hueFor(url) } as CSSProperties}>
        {(title[0] ?? '?').toUpperCase()}
      </span>
    );
  }
  return <img className="bm-favicon" src={faviconUrl(url, 64)} alt="" onError={() => setFailed(true)} />;
}

/** A stable hue per site, so a letter tile keeps its colour across visits. */
export function hueFor(url: string): number {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // the raw string hashes just as well
  }
  let hash = 0;
  for (const char of host) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}
