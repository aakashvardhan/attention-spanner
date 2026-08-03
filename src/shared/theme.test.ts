import { describe, expect, it } from 'vitest';
import { resolveSkin, resolveTheme } from './theme';

describe('resolveTheme', () => {
  it('explicit modes ignore the OS preference', () => {
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
  });

  it('system follows the OS preference', () => {
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
  });
});

describe('resolveSkin', () => {
  it('explicit skins ignore the host browser', () => {
    expect(resolveSkin('brave', false)).toBe('brave');
    expect(resolveSkin('chrome', true)).toBe('chrome');
    expect(resolveSkin('default', true)).toBe('default');
    expect(resolveSkin('default', false)).toBe('default');
  });

  it('auto follows the host browser', () => {
    expect(resolveSkin('auto', true)).toBe('brave');
    expect(resolveSkin('auto', false)).toBe('chrome');
  });

  it('never resolves to auto — the attribute is always a concrete skin', () => {
    const modes = ['auto', 'default', 'chrome', 'brave'] as const;
    for (const mode of modes) {
      for (const isBrave of [true, false]) {
        expect(resolveSkin(mode, isBrave)).not.toBe('auto');
      }
    }
  });
});
