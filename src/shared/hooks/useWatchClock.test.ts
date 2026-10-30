import { describe, expect, it } from 'vitest';
import { watchTickMs } from './useWatchClock';

describe('watchTickMs', () => {
  it('ticks every 500ms while a video plays', () => expect(watchTickMs(true)).toBe(500));
  it('stands still otherwise', () => expect(watchTickMs(false)).toBeNull());
});
