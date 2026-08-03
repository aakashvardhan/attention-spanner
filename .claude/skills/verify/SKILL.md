---
name: verify
description: Build the extension and drive it end-to-end in Chromium via Playwright — load dist/ unpacked, open newtab/sidepanel/options pages, interact, screenshot.
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
- `chrome-extension://${extId}/src/pages/sidepanel/index.html` — side panel
- `chrome-extension://${extId}/src/pages/options/index.html` — options

There is no popup. The side panel is the toolbar surface, opened by
`sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` in the worker —
which Playwright cannot click, so open the page directly instead. Give it a
narrow viewport (`setViewportSize({ width: 360, height: 700 })`) so the layout
you see is the layout Chrome docks.

## Flows worth driving

- Dashboard renders (`.dashboard`, `section.ui-panel` cards — the class is
  `ui-panel`, not `panel`); wait ~2s for storage.
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
- Side panel tab locator: `hasText: 'Ask'` also matches "T**ask**s". The tabs
  used to carry emoji to disambiguate; they are plain text now, so match exactly
  (`getByRole('button', { name: 'Ask', exact: true })`).
- The panel's Live tab is only in the DOM while a recording runs. To exercise
  it, seed `chrome.storage.session` with a `liveSession` whose `recordingId` is
  non-empty; clearing it back to `''` should drop you on Ask, not a blank pane.
- The panel's tabs are a real tablist. Locate them with
  `getByRole('tab', { name: /Tasks/ })`, not `getByRole('button')`.
- **Headless Chromium reports `prefers-reduced-transparency: reduce`**, so the
  glass is off by default and you are looking at the accessibility fallback, not
  what a user sees. Playwright has no option for this feature; force it over
  CDP before `goto`:

  ```js
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }],
  });
  ```

  The same call drives `prefers-contrast` for checking the Increase Contrast
  path. To measure contrast through a blurred translucent plate you have to read
  back composited pixels — `getComputedStyle` reports the declared colour, which
  is not what lands on screen.
- The extension id changes per profile; always derive it from the service worker.
- **Writing a byte-identical value with `chrome.storage.set` does NOT fire
  `storage.onChanged`**, so derived state that recomputes off that listener (the
  toolbar badge) will not update. Seeding storage directly also skips whatever
  the real handler does around the write. To test derived state, drive the
  actual message (`chrome.runtime.sendMessage({ type: 'REC_START', … })`) rather
  than staging storage and hoping a listener notices.
- Mic-dependent flows work headless with
  `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`; a bogus
  Gemini key then exercises the failure path (recording settles to `failed`
  with the key error) rather than the transcription path.
- Cards that live in the dashboard's "connect tray" until configured (Recordings
  needs `settings.geminiApiKey`) are absent from the grid until you seed the key.
