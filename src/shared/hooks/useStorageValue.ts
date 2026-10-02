import { useEffect, useState } from 'react';
import { DEFAULTS, type LocalSchema } from '../storage';

/**
 * Reads a chrome.storage.local key and stays subscribed to changes.
 * All UI reactivity flows through this — the service worker writes storage,
 * every open surface re-renders. Returns [value, loaded].
 */
export function useStorageValue<K extends keyof LocalSchema>(key: K): [LocalSchema[K], boolean] {
  const [value, setValue] = useState<LocalSchema[K]>(() => structuredClone(DEFAULTS[key]));
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;

    const load = () =>
      chrome.storage.local.get(key).then((stored) => {
        if (!alive) return;
        setValue((stored[key] as LocalSchema[K]) ?? structuredClone(DEFAULTS[key]));
        setLoaded(true);
      });
    void load();

    const listener = (
      changes: { [name: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area === 'local' && key in changes) {
        setValue((changes[key].newValue as LocalSchema[K]) ?? structuredClone(DEFAULTS[key]));
      }
    };
    chrome.storage.onChanged.addListener(listener);

    // Chrome freezes long-backgrounded tabs, and change events that fire while
    // a tab is frozen are never delivered — a dashboard left open in another
    // tab would otherwise come back showing whatever it last saw. Re-read on
    // every return to visible.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(listener);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [key]);

  return [value, loaded];
}
