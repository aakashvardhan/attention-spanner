import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectCapabilities } from './capabilities';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectCapabilities', () => {
  it('is not Brave when navigator.brave is absent (the vitest baseline)', () => {
    expect(detectCapabilities().isBrave).toBe(false);
  });

  it('detects Brave by navigator.brave, without calling the async isBrave()', () => {
    vi.stubGlobal('navigator', { brave: { isBrave: () => Promise.resolve(true) } });
    expect(detectCapabilities().isBrave).toBe(true);
  });
});
