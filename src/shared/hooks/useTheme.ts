import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, patchSettings } from '../storage';
import { applyTheme, type ResolvedTheme } from '../theme';
import type { ThemeSetting } from '../types';
import { useStorageValue } from './useStorageValue';

/**
 * Applies settings.theme to the page and keeps it applied: re-runs when the
 * setting changes on any surface, and follows OS scheme changes while 'system'.
 * Call once from each page's root component.
 */
export function useTheme(): {
  mode: ThemeSetting;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeSetting) => void;
} {
  const [settings, loaded] = useStorageValue('settings');
  // Stored settings written before this field existed lack `theme`
  const mode = { ...DEFAULT_SETTINGS, ...settings }.theme;
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );

  useEffect(() => {
    // Until storage loads, `mode` is the default — leave initTheme()'s
    // mirror-based application in place or an explicit theme flashes away
    if (!loaded) return;
    setResolved(applyTheme(mode));
    if (mode !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolved(applyTheme('system'));
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [mode, loaded]);

  return { mode, resolved, setMode: (t) => void patchSettings({ theme: t }) };
}
