import { detectCapabilities } from './capabilities';
import { DEFAULT_SETTINGS } from './storage';
import type { SkinSetting, ThemeSetting } from './types';

export type ResolvedTheme = 'light' | 'dark';
export type ResolvedSkin = 'default' | 'chrome' | 'brave';

/**
 * localStorage mirror of settings.theme. chrome.storage is async, so first
 * paint would flash light without a synchronously readable copy; all extension
 * pages share one chrome-extension:// origin, so one mirror serves them all.
 */
const MIRROR_KEY = 'themeMode';

/** Same mirror trick for the skin — an unmirrored skin flashes the wrong accent. */
const SKIN_MIRROR_KEY = 'skinMode';

export function resolveTheme(mode: ThemeSetting, prefersDark: boolean): ResolvedTheme {
  return mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
}

/**
 * The one place browser identity is allowed to change behaviour, and it changes
 * only colour. capabilities.ts forbids gating *features* on `isBrave` — that
 * rule stands; a skin is not a feature, and there is no capability to detect
 * here because "which browser's palette do you want" is not a capability.
 */
export function resolveSkin(mode: SkinSetting, isBrave: boolean): ResolvedSkin {
  if (mode !== 'auto') return mode;
  return isBrave ? 'brave' : 'chrome';
}

export function applyTheme(mode: ThemeSetting): ResolvedTheme {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = resolveTheme(mode, prefersDark);
  document.documentElement.dataset.theme = resolved;
  localStorage.setItem(MIRROR_KEY, mode);
  return resolved;
}

export function applySkin(mode: SkinSetting): ResolvedSkin {
  const resolved = resolveSkin(mode, detectCapabilities().isBrave);
  document.documentElement.dataset.skin = resolved;
  localStorage.setItem(SKIN_MIRROR_KEY, mode);
  return resolved;
}

function storedSkin(): SkinSetting {
  const raw = localStorage.getItem(SKIN_MIRROR_KEY);
  return raw === 'default' || raw === 'chrome' || raw === 'brave' || raw === 'auto'
    ? raw
    : DEFAULT_SETTINGS.skin;
}

/** Call at module top of each page's main.tsx, before React mounts (MV3 CSP forbids inline scripts) */
export function initTheme(): void {
  const stored = localStorage.getItem(MIRROR_KEY);
  applyTheme(stored === 'light' || stored === 'dark' ? stored : 'system');
  applySkin(storedSkin());
}
