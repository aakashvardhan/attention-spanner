import { afterEach, expect, it, vi } from 'vitest';
import { clearRetiredAlarms } from './alarms';

afterEach(() => vi.unstubAllGlobals());

it('clearRetiredAlarms clears nudges, feeds and Pomodoro alarms and leaves live ones', async () => {
  const alarms = new Set(['nudge|abc', 'nudge|paper:1', 'refresh-feeds', 'focus-phase-end', 'focus-badge-tick', 'a-live-alarm']);
  vi.stubGlobal('chrome', {
    alarms: {
      clear: async (name: string) => alarms.delete(name),
      getAll: async () => [...alarms].map((name) => ({ name })),
    },
  });
  await clearRetiredAlarms();
  expect([...alarms]).toEqual(['a-live-alarm']);
});
