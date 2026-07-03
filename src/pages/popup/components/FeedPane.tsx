import { useMemo, useState } from 'react';
import { MAX_LIST_ITEMS } from '../../../shared/constants';
import { formatRelativeDate } from '../../../shared/format';
import type { useFeed } from '../../../shared/hooks/useFeed';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { sendMessage } from '../../../shared/messages';
import type { AnyProgress, FeedItem } from '../../../shared/types';
import { ContinueReading } from './ContinueReading';

export function FeedPane({ feed }: { feed: ReturnType<typeof useFeed> }) {
  const [filter, setFilter] = useState('all');
  const [readingProgress] = useStorageValue('readingProgress');

  const sources = useMemo(
    () => [...new Set(feed.items.map((item) => item.source))].sort(),
    [feed.items],
  );

  const effectiveFilter = filter !== 'all' && !sources.includes(filter) ? 'all' : filter;
  const filtered =
    effectiveFilter === 'all'
      ? feed.items
      : feed.items.filter((item) => item.source === effectiveFilter);

  if (!feed.loaded || (feed.refreshing && feed.items.length === 0)) {
    return (
      <main>
        <div className="center-state">
          <div className="spinner" />
          <p>Loading feeds…</p>
        </div>
      </main>
    );
  }

  if (feed.feeds.length === 0) {
    return (
      <main>
        <div className="center-state">
          <p>No feeds added yet.</p>
          <button onClick={() => chrome.runtime.openOptionsPage()}>Add a feed</button>
        </div>
      </main>
    );
  }

  if (feed.error && feed.items.length === 0) {
    return (
      <main>
        <div className="center-state error">
          <p>{feed.error}</p>
          <button onClick={() => void feed.refresh()}>Retry</button>
        </div>
      </main>
    );
  }

  return (
    <>
      <div className="filter-bar">
        <select value={effectiveFilter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All Feeds ({feed.items.length})</option>
          {sources.map((source) => (
            <option key={source} value={source}>
              {source} ({feed.items.filter((item) => item.source === source).length})
            </option>
          ))}
        </select>
      </div>
      <main>
        <ContinueReading />
        <div className="feed-list">
          {filtered.slice(0, MAX_LIST_ITEMS).map((item) => (
            <FeedItemCard
              key={item.id}
              item={item}
              read={feed.readItems.includes(item.id)}
              progress={readingProgress[item.normalizedLink]}
            />
          ))}
          {filtered.length === 0 && <p className="no-results">No items for this feed.</p>}
        </div>
      </main>
    </>
  );
}

function FeedItemCard({
  item,
  read,
  progress,
}: {
  item: FeedItem;
  read: boolean;
  progress?: AnyProgress;
}) {
  const inProgress = progress && progress.completedAt === null && progress.maxPercent >= 5;
  return (
    <article
      className={read ? 'feed-item read' : 'feed-item'}
      onClick={() =>
        void sendMessage({
          type: 'OPEN_ARTICLE',
          url: item.link,
          feedItemId: item.id,
          resume: Boolean(inProgress),
        })
      }
    >
      <h3 className="feed-item-title">{item.title}</h3>
      <div className="feed-item-meta">
        <span className="feed-item-source">{item.source}</span>
        <span className="feed-item-right">
          {inProgress && <span className="progress-chip">{progress.maxPercent}%</span>}
          {progress && progress.completedAt !== null && (
            <span className="progress-chip done-chip">✓</span>
          )}
          <span className="feed-item-date">{formatRelativeDate(new Date(item.pubDate))}</span>
        </span>
      </div>
      <p className="feed-item-snippet">{item.snippet}</p>
    </article>
  );
}
