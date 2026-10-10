export const NARROW_QUERY = '(max-width: 900px)';
export const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Which arrangement the new tab uses. The world is a choice, never a
 * requirement: Reduce Motion and a narrow window both get the flat Edition.
 */
export function viewMode(setting: 'world' | 'flat', reducedMotion: boolean, narrow: boolean): 'world' | 'flat' {
  return reducedMotion || narrow ? 'flat' : setting;
}

/** A CSS time in ms. Chrome re-serializes custom properties: 520ms reads back as ".52s". */
export function parseDuration(raw: string): number {
  const text = raw.trim();
  const n = parseFloat(text);
  if (!Number.isFinite(n)) return 0;
  return text.endsWith('ms') ? n : n * 1000;
}

/** A duration token's current value, in ms. */
export function tokenMs(name: string): number {
  return parseDuration(getComputedStyle(document.documentElement).getPropertyValue(name));
}
