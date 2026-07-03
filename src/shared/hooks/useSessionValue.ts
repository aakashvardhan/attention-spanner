import { useEffect, useState } from 'react';
import { SESSION_DEFAULTS, type SessionSchema } from '../storage';

/**
 * chrome.storage.session twin of useStorageValue. Extension pages can read
 * session storage (default access level is trusted contexts only, which
 * includes them); content scripts cannot.
 */
export function useSessionValue<K extends keyof SessionSchema>(
  key: K,
): [SessionSchema[K], boolean] {
  const [value, setValue] = useState<SessionSchema[K]>(() =>
    structuredClone(SESSION_DEFAULTS[key]),
  );
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;

    chrome.storage.session.get(key).then((stored) => {
      if (!alive) return;
      setValue((stored[key] as SessionSchema[K]) ?? structuredClone(SESSION_DEFAULTS[key]));
      setLoaded(true);
    });

    const listener = (
      changes: { [name: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area === 'session' && key in changes) {
        setValue((changes[key].newValue as SessionSchema[K]) ?? structuredClone(SESSION_DEFAULTS[key]));
      }
    };
    chrome.storage.onChanged.addListener(listener);

    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [key]);

  return [value, loaded];
}
