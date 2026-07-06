import type { ThemeSetting } from './types';

export type ResolvedTheme = 'light' | 'dark';

/**
 * localStorage mirror of settings.theme. chrome.storage is async, so first
 * paint would flash light without a synchronously readable copy; all extension
 * pages share one chrome-extension:// origin, so one mirror serves them all.
 */
const MIRROR_KEY = 'themeMode';

export function resolveTheme(mode: ThemeSetting, prefersDark: boolean): ResolvedTheme {
  return mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
}

export function applyTheme(mode: ThemeSetting): ResolvedTheme {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = resolveTheme(mode, prefersDark);
  document.documentElement.dataset.theme = resolved;
  localStorage.setItem(MIRROR_KEY, mode);
  return resolved;
}

/** Call at module top of each page's main.tsx, before React mounts (MV3 CSP forbids inline scripts) */
export function initTheme(): void {
  const stored = localStorage.getItem(MIRROR_KEY);
  applyTheme(stored === 'light' || stored === 'dark' ? stored : 'system');
}
