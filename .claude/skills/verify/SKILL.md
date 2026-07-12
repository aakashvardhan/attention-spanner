---
name: verify
description: Build the extension and drive it end-to-end in Chromium via Playwright — load dist/ unpacked, open newtab/popup/options pages, interact, screenshot.
---

# Verifying this Chrome extension

## Build

```bash
npm run build        # vite build + esbuild content scripts → dist/
```

## Drive with Playwright (dev dependency)

Load `dist/` as an unpacked extension in a persistent context. Works headless.
Resolve playwright via the repo (scripts outside the repo need `createRequire`):

```js
import { createRequire } from 'node:module';
const require = createRequire('<repo>/package.json');
const { chromium } = require('playwright');

const ctx = await chromium.launchPersistentContext(tmpProfileDir, {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
```

Pages to open directly (no need to trigger chrome UI):
- `chrome-extension://${extId}/src/pages/newtab/index.html` — dashboard
- `chrome-extension://${extId}/src/pages/popup/index.html` — popup
- `chrome-extension://${extId}/src/pages/options/index.html` — options

## Flows worth driving

- Dashboard renders (`.dashboard`, `section.panel` cards); wait ~2s for storage.
- Command palette: `Control+k`, type, Enter. Fast-path commands (start focus,
  add task) run with no AI — best end-to-end check of the RPC → background →
  storage → re-render loop. Focus start shows `.focus-banner` with countdown.
- Read storage from a page: `page.evaluate(() => chrome.storage.local.get(...))`.
- Collect `console`/`pageerror` events — a clean run has zero.

## Gotchas

- **Gemini Nano is unavailable in test Chromium** — assistant AI replies can't
  be exercised; the degraded paths (hints, disabled input, template briefing)
  are what you can observe. Cloud-key paths need a real key.
- Settings checkboxes are controlled via an async chrome.storage round-trip:
  Playwright's `check()/uncheck()` post-click assertion races it. Use
  `click({ force: true })` + `waitForFunction` on the storage value.
- Popup tab locator: `hasText: 'Ask'` also matches "T**ask**s" — use the emoji
  (`'🤖 Ask'`) or exact text.
- The extension id changes per profile; always derive it from the service worker.
