import { useState } from 'react';
import { Button, EmptyState } from '../../shared/components/ui';
import { formatRelativeDate } from '../../shared/format';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { sendMessage } from '../../shared/messages';

export function XBookmarksPanel() {
  const [items] = useStorageValue('xBookmarks');
  const [lastSyncedAt] = useStorageValue('xBookmarksLastSyncedAt');
  const [opening, setOpening] = useState(false);

  const sync = async () => {
    setOpening(true);
    try {
      await sendMessage({ type: 'X_BOOKMARKS_OPEN' });
    } finally {
      setOpening(false);
    }
  };

  return (
    <section className="relay-x-bookmarks" aria-labelledby="x-bookmarks-title">
      <header className="relay-bookmarks-head">
        <div>
          <h2 id="x-bookmarks-title">X bookmarks</h2>
          <p>
            {lastSyncedAt
              ? `${items.length} saved · synced ${formatRelativeDate(new Date(lastSyncedAt))}`
              : 'Tweets you bookmarked on X.'}
          </p>
        </div>
        <Button variant="ghost" onClick={() => void sync()} disabled={opening}>
          {opening ? 'Opening…' : 'Sync from X'}
        </Button>
      </header>

      {items.length === 0 ? (
        <EmptyState>
          Open your X bookmarks, then scroll through them. They’ll appear here automatically.
        </EmptyState>
      ) : (
        <div className="x-bookmark-list panel-scroll">
          {items.map((item) => (
            <a key={item.id} className="x-bookmark" href={item.url}>
              <span className="x-bookmark-mark" aria-hidden="true">𝕏</span>
              <span className="x-bookmark-body">
                <span className="x-bookmark-byline">
                  <strong>{item.authorName}</strong>
                  <span>{item.authorHandle}</span>
                  {item.postedAt && <time dateTime={new Date(item.postedAt).toISOString()}>{formatRelativeDate(new Date(item.postedAt))}</time>}
                </span>
                <span className={item.text ? 'x-bookmark-text' : 'x-bookmark-text x-bookmark-text--empty'}>
                  {item.text || 'Open this post on X'}
                </span>
              </span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
