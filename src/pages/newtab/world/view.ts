export const NARROW_QUERY = '(max-width: 900px)';
export const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Which arrangement the new tab uses. The world is a choice, never a
 * requirement: Reduce Motion and a narrow window both get the flat Edition.
 */
export function viewMode(setting: 'world' | 'flat', reducedMotion: boolean, narrow: boolean): 'world' | 'flat' {
  return reducedMotion || narrow ? 'flat' : setting;
}
