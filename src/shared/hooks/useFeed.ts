import { useCallback, useEffect, useRef, useState } from 'react';
import { CACHE_TTL_MS } from '../constants';
import { sendMessage } from '../messages';
import { useStorageValue } from './useStorageValue';

/**
 * Feed state for UI surfaces. Items come straight from the storage cache
 * (the service worker is the only fetcher); refresh() asks the worker to
 * re-fetch, and the storage subscription delivers the new items.
 */
export function useFeed() {
  const [feeds, feedsLoaded] = useStorageValue('feeds');
  const [items, itemsLoaded] = useStorageValue('cachedItems');
  const [readItems] = useStorageValue('readItems');
  const [cacheTimestamp, tsLoaded] = useStorageValue('cacheTimestamp');

  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Gates the auto-refresh on the last *attempt*, not the last success — a feed
  // that keeps failing never advances cacheTimestamp, and gating on that would
  // re-fetch on every render for as long as it stays broken.
  const lastAttempt = useRef(0);

  const refresh = useCallback(async () => {
    lastAttempt.current = Date.now();
    setRefreshing(true);
    setError(null);
    try {
      const res = await sendMessage({ type: 'REFRESH_FEEDS' });
      if (!res?.ok) {
        setError('Could not reach your feeds. Showing the last items fetched.');
      } else if (res.failedCount > 0) {
        setError(`${res.failedCount} of ${feeds.length} feeds failed to load.`);
      } else if (res.itemCount === 0) {
        setError('No items found in your feeds.');
      }
    } catch {
      setError('Failed to load feeds. Please try again.');
    } finally {
      setRefreshing(false);
    }
  }, [feeds.length]);

  // Keep an open newtab current: re-check staleness on mount and on every
  // return to visible, since a dashboard can sit in a background tab for hours.
  useEffect(() => {
    if (!feedsLoaded || !tsLoaded) return;

    const refreshIfStale = () => {
      if (feeds.length === 0) return;
      const since = Math.max(cacheTimestamp, lastAttempt.current);
      if (Date.now() - since > CACHE_TTL_MS) void refresh();
    };
    refreshIfStale();

    const onVisibility = () => {
      if (document.visibilityState === 'visible') refreshIfStale();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [feedsLoaded, tsLoaded, feeds, cacheTimestamp, refresh]);

  const unreadCount = items.filter((item) => !readItems.includes(item.id)).length;

  return {
    feeds,
    items,
    readItems,
    cacheTimestamp,
    unreadCount,
    loaded: feedsLoaded && itemsLoaded,
    refreshing,
    error,
    refresh,
  };
}
