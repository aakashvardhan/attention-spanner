import { DEFAULT_SETTINGS } from '../storage';
import type { Settings } from '../types';
import { useStorageValue } from './useStorageValue';

/**
 * Settings, always merged over the defaults. Returns [settings, loaded], the
 * same shape as useStorageValue.
 *
 * The merge is the whole point. `patchSettings` persists the entire settings
 * object, so anyone who has ever opened Settings has a stored copy frozen at
 * the fields that existed that day — and `useStorageValue` hands back exactly
 * what is stored. Read a field added later straight off that object and you get
 * `undefined`, on precisely the profiles that have used the extension longest.
 * A fresh profile has no stored settings at all and falls back to DEFAULTS, so
 * it never reproduces.
 *
 * Every consumer used to spread DEFAULT_SETTINGS itself. That worked until one
 * of them forgot, and `settings.weatherLocation.trim()` threw on the new tab.
 * The merge belongs in one place rather than in the memory of whoever adds the
 * next surface. `getSettings()` does the same thing for the worker side.
 */
export function useSettings(): [Settings, boolean] {
  const [stored, loaded] = useStorageValue('settings');
  return [{ ...DEFAULT_SETTINGS, ...stored }, loaded];
}
