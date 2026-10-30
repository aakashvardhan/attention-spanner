import { afterEach, expect, it, vi } from 'vitest';
import { clearRetiredAlarms } from './alarms';

afterEach(() => vi.unstubAllGlobals());

it('clearRetiredAlarms clears every nudge alarm and leaves live ones', async () => {
  const alarms = new Set(['nudge|abc', 'nudge|paper:1', 'refresh-feeds', 'focus-phase-end']);
  vi.stubGlobal('chrome', {
    alarms: {
      clear: async (name: string) => alarms.delete(name),
      getAll: async () => [...alarms].map((name) => ({ name })),
    },
  });
  await clearRetiredAlarms();
  expect([...alarms].sort()).toEqual(['focus-phase-end', 'refresh-feeds']);
});
