---
name: verify
description: Build the extension and drive it end-to-end in Chromium via Playwright — load dist/ unpacked, open the newtab/options/papers/reader pages, interact, screenshot.
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
- `chrome-extension://${extId}/src/pages/options/index.html` — options
- `chrome-extension://${extId}/src/pages/papers/index.html` — papers
- `chrome-extension://${extId}/src/pages/reader/index.html?article=<encoded url>`
  — the reader (`?src=` for a PDF; no param renders the fallback copy)

There is no popup and, since the side panel was removed, no docked surface
either. The toolbar icon runs `chrome.action.onClicked` in the worker and opens
the dashboard. Playwright cannot click the icon, but it can fire the listener
from the worker target:

```js
await sw.evaluate(() => chrome.action.onClicked.dispatch({ id: 1 }));
```

## Flows worth driving

- New tab (layout C): `.edition` holds two columns. `.now-col` is
  the Pomodoro (`.pomo`), the brain dump (`section[aria-label="Brain dump"]`)
  and the heatmap (`.heat`); `.read-col` is `section[aria-label="Continue"]`
  (sub-lists `Continue reading` / `Continue watching`),
  `section[aria-label="Deck"]` (open questions) and `section[aria-label="News"]`
  (hidden during a focus round). Each list shows 5 rows, then `button.show-all`.
  Every openable row is a `.row` with `[data-story]` (J/K walk them, Enter
  opens the selected one). Papers and Settings live in `.edition-index`
  (below 720px the columns stack, Now first). The Pomodoro: idle it is
  `.pomo-start` (or key C); running it shows `.pomo-status` and carries
  `data-phase`, and so does `<html>`. A seeded `focusSession` needs `phase`,
  `round` and `phaseStartedAt` or it reads as not focusing. To end a phase,
  set `phaseEndsAt: Date.now()` and fire `focus-phase-end` from the worker
  with `chrome.alarms.create`; the chime is an offscreen document, visible via
  `chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })`. Wait ~1.5s for storage. Seed `readingProgress` with real
  fields (`maxPercent`, `updatedAt`, `completedAt: null`) or Continue
  stays empty.
- Reader (the Observatory): `.reader-root[data-chrome]` is `awake`/`asleep`
  (sleeps 2.5s after load with no panel open; `mouse.move(x, 10)` wakes it);
  status is `.reader-capsule` (click `.reader-capsule-summary` for page jump and
  zoom, Escape folds it); announcements land in `.reader-capsule-message`; the
  outline at rest is `.reader-rail` with one `[data-state="current"]` tick; F
  sets `[data-focus-line]`..
- Retired settings must stay inert: seed `settings.skin` with an old value and
  expect no errors.
- Read storage from a page: `page.evaluate(() => chrome.storage.local.get(...))`.
- Collect `console`/`pageerror` events — a clean run has zero.

## Gotchas

- **Local AI runs on Ollama** (`src/shared/llm/`). Drive it with a mock: a node
  `http` server answering `GET /api/tags`, `POST /api/show`, `POST /api/chat`
  (NDJSON lines `{"message":{"content":…}}` then `{"done":true}`) and
  `POST /api/embed` (`{"embeddings":[…]}`), with `settings.ollamaUrl` pointed
  at it. To mimic real Ollama's origin check, 403 any `/api/*` request whose
  Origin is `chrome-extension://…` until "allowed" — note Chrome sends no Origin
  on an extension page's GET, only on POST. Intercept
  `https://api.anthropic.com/**` with `ctx.route` and assert zero hits for
  private sources (web pages, local PDFs, highlights).
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
