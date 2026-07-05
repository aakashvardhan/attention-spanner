---
name: verify
description: Build and drive this Chrome extension (MV3) in a real browser to verify changes end-to-end.
---

# Verifying adhd-chrome-reader changes

## Build

```bash
npm run build   # tsc + vite + esbuild content scripts → dist/
```

## Launch with the extension loaded

Branded Google Chrome **ignores `--load-extension`** (removed in Chrome 137+).
Use Playwright's bundled Chromium instead:

```bash
npx playwright install chromium   # one-time
```

```js
import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext(tmpProfileDir, {
  headless: false,               // extensions need headed (or new headless)
  viewport: { width: 1400, height: 950 },
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
```

## Surfaces

- New tab dashboard: `chrome-extension://<extId>/src/pages/newtab/index.html`
  (navigating there directly beats `chrome://newtab`)
- Options: `chrome-extension://<extId>/src/pages/options/index.html`
- Popup: `chrome-extension://<extId>/src/pages/popup/index.html`

## Inspecting storage from a driven page

Extension pages have the `chrome` API, so:

```js
await page.evaluate(() => chrome.storage.local.get('settings'));
```

## Gotchas

- `rtk` wraps npx/playwright and can garble output — prefix with `rtk proxy` if
  a command fails with `[RTK:PASSTHROUGH]`.
- Don't take `fullPage: true` screenshots mid-drag — the scroll cancels/derails
  dnd-kit drags. Viewport screenshots are fine.
- dnd-kit drags need: mouse.down on the handle, a small first move (> the 8px
  activation distance), stepped moves to the target, a ~300ms pause, then
  mouse.up, then ~400ms for the storage echo to re-render.
- `chrome.runtime.reload()` does NOT come back under `--load-extension`
  (ERR_BLOCKED_BY_CLIENT, no new service worker). To simulate a restart,
  close the persistent context and relaunch it on the same profile dir —
  that also fires `chrome.runtime.onStartup`.
