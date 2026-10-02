import { type CSSProperties, useState } from 'react';
import { Button, EmptyState } from '../../shared/components/ui';
import { faviconUrl } from '../../shared/format';
import { useBookmarks } from '../../shared/hooks/useBookmarks';
import { sendMessage } from '../../shared/messages';
import { CardTitle, Icon } from './Icon';

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
    <section className="relay-bookmarks" aria-labelledby="bookmark-links-title">
      <header className="relay-bookmarks-head">
        <CardTitle id="bookmark-links-title" icon="star">Favorites</CardTitle>
        <div className="relay-bookmarks-actions">
          <Button variant="ghost" aria-expanded={adding} onClick={() => setAdding((current) => !current)}>
            {!adding && <Icon name="plus" />}
            {adding ? 'Cancel' : 'Add link'}
          </Button>
          {bookmarks.bookmarks.length > 0 && (
            <Button
              variant="ghost"
              className={editing ? 'editing' : undefined}
              onClick={() => setEditing((current) => !current)}
            >
              {!editing && <Icon name="edit" />}
              {editing ? 'Done' : 'Edit'}
            </Button>
          )}
        </div>
      </header>

      <div className="panel-scroll">
        {bookmarks.grouped.length === 0 && (
          <EmptyState>
            No favorites yet. Use Add link, or right-click any page and choose “Bookmark this
            page”.
          </EmptyState>
        )}
        {bookmarks.grouped.map((group) => (
          <div key={group.id ?? 'unsorted'} className="bm-group">
            <p className="row-label bm-group-head">
              <span>{group.name}</span>
              {editing && group.id !== null && (
                <Button
                  variant="ghost"
                  title={`Delete ${group.name}`}
                  aria-label={`Delete ${group.name} group`}
                  onClick={() => {
                    if (window.confirm(`Delete group "${group.name}"? Its links will move to Unsorted.`)) {
                      void bookmarks.deleteGroup(group.id!);
                    }
                  }}
                >
                  Delete group
                </Button>
              )}
            </p>
            <div className="bm-grid">
              {group.links.map((link) => (
                <div key={link.id} className="bm-tile-wrap">
                  {/* The href stays so middle-click, modifier-click and "open in
                      new tab" keep working; a plain left click is the one we
                      reroute. A bookmark opens the page itself, not the
                      reader: it is somewhere you go (openArticle). */}
                  <a
                    className="bm-tile"
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
                    <span className="bm-name">{link.title}</span>
                  </a>
                  {editing && (
                    <div className="bm-edit">
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
                      <Button
                        variant="ghost"
                        title={`Delete ${link.title}`}
                        aria-label={`Delete ${link.title}`}
                        onClick={() => void bookmarks.deleteBookmark(link.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

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
