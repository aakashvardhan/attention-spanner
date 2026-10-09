import { defineConfig } from 'vitest/config';

// Drives the built extension (dist/, from `npm run build:e2e`) in Chromium.
// Kept out of `npm test`: these need a browser and take tens of seconds.
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    // No retries: each file shares one browser profile, so a retried test
    // meets the storage its first attempt left behind. Generous polls instead,
    // since every check after a service-worker round trip waits on IPC.
    retry: 0,
    expect: { poll: { timeout: 5000 } },
  },
});
