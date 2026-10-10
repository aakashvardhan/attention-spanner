import { describe, expect, it } from 'vitest';
import { viewMode } from './view';
import { ambientRunning } from '../../../shared/hooks/useAmbient';

describe('viewMode', () => {
  it('honours the setting when motion is allowed and the window is wide', () => {
    expect(viewMode('world', false, false)).toBe('world');
    expect(viewMode('flat', false, false)).toBe('flat');
  });

  it('is always flat under Reduce Motion or in a narrow window', () => {
    expect(viewMode('world', true, false)).toBe('flat');
    expect(viewMode('world', false, true)).toBe('flat');
  });
});

describe('ambientRunning', () => {
  const on = { enabled: true, reduced: false, focusing: false, hidden: false };
  it('runs only when enabled, motion is allowed, no focus session and the tab is visible', () => {
    expect(ambientRunning(on)).toBe(true);
    expect(ambientRunning({ ...on, enabled: false })).toBe(false);
    expect(ambientRunning({ ...on, reduced: true })).toBe(false);
    expect(ambientRunning({ ...on, focusing: true })).toBe(false);
    expect(ambientRunning({ ...on, hidden: true })).toBe(false);
  });
});
