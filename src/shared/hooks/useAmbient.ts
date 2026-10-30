import { useEffect, useState } from 'react';
import { patchSettings } from '../storage';
import { useMedia } from './useMedia';
import { useSettings } from './useSettings';
import { useStorageValue } from './useStorageValue';

export function ambientRunning(a: { enabled: boolean; reduced: boolean; focusing: boolean; hidden: boolean }): boolean {
  return a.enabled && !a.reduced && !a.focusing && !a.hidden;
}

/**
 * The one switch for motion nobody asked for: the sky, the clouds, the
 * runners. Off when the setting is off, during a focus round (a break brings
 * it back), under Reduce
 * Motion and while the tab is hidden. Reads the session from storage rather
 * than useFocusSession, which ticks twice a second.
 */
export function useAmbient(): { running: boolean; enabled: boolean; toggle(): void } {
  const [settings] = useSettings();
  const [session] = useStorageValue('focusSession');
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  const enabled = settings.ambientMotion;
  return {
    running: ambientRunning({ enabled, reduced, focusing: session !== null && session.phase !== 'break', hidden }),
    enabled,
    toggle: () => void patchSettings({ ambientMotion: !enabled }),
  };
}
