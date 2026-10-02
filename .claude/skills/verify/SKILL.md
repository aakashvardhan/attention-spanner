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

- New tab (the Edition): `.edition` is the page (a `.grid`), `.edition-masthead`
  the top band (h1 is the edition name), `.edition-lead` the lead story, and
  every openable story carries `[data-story]` (J/K walk them, Enter opens the
  lead). Favorites, Papers, Settings and focus live in `.edition-index`;
  starting focus swaps the `.edition-pill` for `.edition-focus-live` with the
  countdown and Stop. Wait ~1.5s for storage. Seed `readingProgress` with real
  fields (`maxPercent`, `updatedAt`, `completedAt: null`, `nudge`) or the
  lead stays empty.
- Reader (the Observatory): `.reader-root[data-chrome]` is `awake`/`asleep`
  (sleeps 2.5s after load with no panel open; `mouse.move(x, 10)` wakes it);
  status is `.reader-capsule` (click `.reader-capsule-summary` for page jump and
  zoom, Escape folds it); announcements land in `.reader-capsule-message`; the
  outline at rest is `.reader-rail` with one `[data-state="current"]` tick; F
  sets `[data-focus-line]`. The drift nudge needs `page.clock.install()` before
  `goto` — sample in 5s steps, the message hides after 10s.
- Retired settings must stay inert: seed `settings.skin` with an old value and
  expect no errors.
- The Now watching card only mounts while a video is playing. Seed a
  `readingProgress` entry with `kind: 'video'`, `playing: true` and a fresh
  `updatedAt` (liveness is `now - updatedAt < VIDEO_WATCHING_STALE_MS`).
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
- Mic-dependent flows work headless with
  `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`; a bogus
  Gemini key then exercises the failure path (recording settles to `failed`
  with the key error) rather than the transcription path.
- Cards that live in the dashboard's "connect tray" until configured (Recordings
  needs `settings.geminiApiKey`) are absent from the grid until you seed the key.
