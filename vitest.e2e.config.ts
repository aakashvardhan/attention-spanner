import { defineConfig } from 'vitest/config';

// Drives the built extension (dist/, from `npm run build:e2e`) in Chromium.
// Kept out of `npm test`: these need a browser and take tens of seconds.
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    retry: process.env.CI ? 1 : 0,
  },
});
