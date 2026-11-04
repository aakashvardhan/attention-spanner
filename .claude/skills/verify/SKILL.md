---
name: verify
description: Build the extension and drive it end-to-end in Chromium via Playwright — load rust/ext/dist/chromium unpacked, open the newtab/options/papers/reader pages, interact, screenshot.
---

# Verifying this Chrome extension

## Build

```bash
npm run build:ext    # Rust → wasm → rust/ext/dist/chromium (npm run build adds the brain MCP server)
```

The build writes to `rust/ext/.build/chromium` and only swaps it into `dist/chromium` when
complete (`scripts/publish-ext.mjs`), so a Chrome with dist loaded never sees a half-written build.

## Drive with Playwright (dev dependency)

Load `rust/ext/dist/chromium` as an unpacked extension in a persistent context. Works headless.
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
- `chrome-extension://${extId}/src/pages/options/index.html` — options
- `chrome-extension://${extId}/src/pages/papers/index.html` — papers
- `chrome-extension://${extId}/src/pages/reader/index.html?src=<encoded pdf url>`
  — the reader (no param renders the fallback copy)

There is no popup and, since the side panel was removed, no docked surface
either. The toolbar icon runs `chrome.action.onClicked` in the worker and opens
the dashboard. Playwright cannot click the icon, but it can fire the listener
from the worker target:

```js
await sw.evaluate(() => chrome.action.onClicked.dispatch({ id: 1 }));
```

## Flows worth driving

- New tab: `.edition` is `.board` on the left (three `.board-col`: In progress,
  To read, Completed, bucketed by `progressPercent`/`lastReadAt`; `.paper-card`
  each, the newest in-progress card lists explain-back gaps with `a.gap-page`)
  and `.side-col` on the right (brain dump `section[aria-label="Brain dump"]`,
  heatmap `.heat`). A card whose title equals `focusSession.title` gets
  `.paper-card--reading` and a blinking `.live-dot`; seed `focusSession` with a
  real tab id (`chrome.tabs.getCurrent()`) or the worker prunes it. Papers and
  Settings live in `.edition-index`.
- Papers page: card decks. `.shelf` per folder, `.book` card buttons (one has
  `tabindex="0"`; arrows move it), Enter opens `.book-card`, M opens
  `.move-menu`, the cart is `section.cart` (needs `alphaxivAuth` seeded and the
  MCP endpoint routed).
- Papers come from alphaXiv: seed `folders` (`{id,name,type}`) and `papers`
  keyed by arXiv id with `folderIds`. Non-arXiv papers do not exist any more.
- Reading session: opening the reader sends `READER_OPENED`, which puts the tab
  in `focusSession.tabIds` and redirects `settings.focusBlocklist` hosts to the
  blocked page; closing the last reader tab sets `focusSession: null`.
- Reader (the Observatory): `.reader-root[data-chrome]` is `awake`/`asleep`
  (sleeps 2.5s after load with no panel open; `mouse.move(x, 10)` wakes it);
  status is `.reader-capsule` (click `.reader-capsule-summary` for page jump and
  zoom, Escape folds it); announcements land in `.reader-capsule-message`; the
  outline at rest is `.reader-rail` with one `[data-state="current"]` tick; F
  sets `[data-focus-line]`.
- Retired settings must stay inert: seed `settings.skin` with an old value and
  expect no errors.
- Read storage from a page: `page.evaluate(() => chrome.storage.local.get(...))`.
- Collect `console`/`pageerror` events — a clean run has zero.

## Gotchas

- **AI is Claude Haiku only** (`src/shared/llm/`, alphaXiv grounds, Haiku
  writes). Mock it with `mockClaude(ext, reply)` from `e2e/harness.ts`: a
  `ctx.route` on `https://api.anthropic.com/**` answering with an SSE stream.
  Seed `settings.claudeKey` or every AI call reports "unavailable".
- Settings checkboxes are controlled via an async chrome.storage round-trip:
  Playwright's `check()/uncheck()` post-click assertion races it. Use
  `click({ force: true })` + `waitForFunction` on the storage value.
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
