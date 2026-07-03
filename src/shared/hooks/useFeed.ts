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
  const autoRefreshed = useRef(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await sendMessage({ type: 'REFRESH_FEEDS' });
      if (!res?.ok) {
        setError('Failed to load feeds. Please try again.');
      } else if (res.itemCount === 0) {
        setError('No items found in your feeds.');
      }
    } catch {
      setError('Failed to load feeds. Please try again.');
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Refresh once on mount if the cache is stale (same 5-min TTL as the old popup)
  useEffect(() => {
    if (!feedsLoaded || !tsLoaded || autoRefreshed.current) return;
    autoRefreshed.current = true;
    if (feeds.length > 0 && Date.now() - cacheTimestamp > CACHE_TTL_MS) {
      void refresh();
    }
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
