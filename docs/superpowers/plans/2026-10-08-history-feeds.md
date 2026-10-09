# History Feeds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suggest feeds from the sites you visit, let you mute topics in the triage card, collapse one story told by several feeds into one row, and put the whole extension under a browser-driven CI suite (regression, edge cases, load, accessibility, Chromium built-ins).

**Architecture:** Discovery and muting are pure functions in `src/shared/` with the browser IO injected, so every error path is a unit test. The Options page owns the history permission request (it must run inside the click). TriageCard gains a mute filter and a clustering pass between embedding rank and Laya rerank. A new `e2e/` suite drives the built extension in Chromium through Playwright (already a dev dependency) under Vitest, in a second CI job.

**Tech Stack:** React 19, TypeScript 5.8 strict, Vite + CRXJS (MV3), Vitest 3, Playwright 1.61 (library, not `@playwright/test`), axe-core (new dev dependency), Ollama (local embeddings).

**Spec:** `docs/superpowers/specs/2026-10-08-history-feeds-design.md`

## Global Constraints

- Work in the `history-feeds` worktree (`../adhd-chrome-reader-history-feeds`), except Task 1, which runs in the main checkout.
- Read settings through `useSettings()` (pages) or `getSettings()` (worker). Never `useStorageValue('settings')`.
- A new setting is a field on `Settings` plus its value in `DEFAULT_SETTINGS`. No migration.
- New CSS uses theme tokens or `src/shared/designSystem.test.ts` fails: colours only as `var(--*)` (or `transparent`), px values multiples of 4 (1px borders are fine), `font-size: var(--text-*)`, radii `var(--radius-*)`.
- `history` is an **optional** permission (`optional_permissions`), requested only from the click on "Suggest from my history". Only the E2E build (`E2E=1`) lists it under `permissions`.
- Discovery fetches use `credentials: 'omit'`. Nothing from history is stored or sent anywhere.
- No emojis in UI copy or code comments.
- Only new dependency: `axe-core` (dev). Say so in the commit that adds it.
- `npm run typecheck`, `npm test`, `npm run build` stay green after every task. From Task 2 on, `npm run build:e2e && npm run test:e2e` too.

## Review Focus

1. A site whose front page redirects to a login or cookie-consent page: no feed found, counted as checked, no hang, no suggestion. (Task 4 test "a redirect to a page with no feed link")
2. A followed feed on a `feeds.` subdomain (`feeds.arstechnica.com`) must suppress `arstechnica.com`, and the reverse. (Task 4 test "subdomain feeds count as followed")
3. Clicking "Suggest" twice, or leaving the page mid-scan: the old scan aborts, nothing updates after unmount. (Task 4 test "abort stops the scan"; Task 5 cancel step)
4. A muted topic with regex characters or non-English letters (`C++`, `Économie`) matches as a whole word and never throws. (Task 6 tests)
5. A stored `mutedTopics` that is not an array (hand-edited storage, an old export): read as a list or as empty, never a crash. (Task 6 `normalizeTopics` tests; Task 7 e2e "corrupted mutedTopics")

## Corrections to the spec, found while planning

- `chrome.history` `visitCount` is an all-time count per URL, not a count inside the 7-day window. The chip therefore reads `lwn.net · visited 14 times`, not "this week". Getting a true weekly count needs one `getVisits` call per URL; not worth it for a label.
- Sites are grouped by `host` (hostname plus port), not hostname alone, and the front page is fetched from the origin of the most recent visit (keeps `http:` for sites that only serve http). This is also what lets the E2E suite run against a local server.

---

### Task 1: Clean up stray files (main checkout)

**Files:**
- Delete: 90 untracked `* 2.*` files under `src/`, `prof-izwfGL/`, `prof-oLcejq/`, `newtab.png`, `reader.png`, `reader-zoomed.png`
- Modify: `.gitignore`

Untracked files only. Nothing tracked is touched, so there is nothing to test beyond the existing suite.

- [ ] **Step 1: Confirm the duplicate list is still what the spec describes**

Run (main checkout `/Users/aakashvardhan/Documents/adhd-chrome-reader`):
```bash
git status --porcelain -uall | grep '^?? ' | sed 's/^?? //; s/"//g' | grep ' 2\.' > /tmp/dups.txt; wc -l < /tmp/dups.txt
while IFS= read -r f; do o="${f/ 2./.}"; if [ -f "$o" ] && cmp -s "$f" "$o"; then echo same; elif [ "$f" -ot "$o" ]; then echo older; else echo "NEWER $f"; fi; done < /tmp/dups.txt | sort | uniq -c
```
Expected: `90`, then `82 same` and `8 older`, and no `NEWER` line. If any line says `NEWER`, stop and ask: that copy has edits the original lacks.

- [ ] **Step 2: Delete them and the stray profiles and screenshots**

```bash
while IFS= read -r f; do rm -- "$f"; done < /tmp/dups.txt
rm -rf prof-izwfGL prof-oLcejq
rm -f newtab.png reader.png reader-zoomed.png
```

- [ ] **Step 3: Ignore future verify profiles**

Append to `.gitignore`:
```
# Throwaway Chrome profiles from /verify runs
prof-*/
```

- [ ] **Step 4: Check nothing tracked changed and the suite still passes**

Run: `git status --porcelain | grep -v '^??'` and `npm test`
Expected: only ` M .gitignore` plus the pre-existing `pixel-walk` modifications; tests PASS (522).

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "Ignore throwaway verify profiles"
```
Commit only `.gitignore`; leave the `pixel-walk` work uncommitted for its owner.

---

### Task 2: Browser test harness, smoke regression suite, CI job

**Files:**
- Create: `vitest.e2e.config.ts`, `e2e/tsconfig.json`, `e2e/harness.ts`, `e2e/sites.ts`, `e2e/seed.ts`, `e2e/a11yBaseline.ts`, `e2e/smoke.e2e.ts`
- Modify: `package.json` (scripts, `axe-core` dev dependency), `.github/workflows/ci.yml`, `.gitignore`

**Interfaces:**
- Produces (used by Tasks 5, 6, 7, 8, 9):
  - `launch(): Promise<Ext>` where `interface Ext { ctx: BrowserContext; sw: Worker; id: string; sites: Sites; errors: string[]; page(path: string): Promise<Page>; close(): Promise<void> }`
  - `seed(ext: Ext, data: Record<string, unknown>): Promise<void>`
  - `storage<T>(ext: Ext, key: string): Promise<T>`
  - `expectClean(ext: Ext, allow?: RegExp[]): void` and `NETWORK_NOISE: RegExp[]`
  - `axe(page: Page): Promise<{ id: string; nodes: number }[]>`
  - `expectA11y(page: Page, pageName: string): Promise<void>`
  - `PAGES: Record<'newtab' | 'options' | 'papers' | 'reader' | 'blocked', string>`
  - `interface Sites { port: number; origin(host: string): string; }` serving `http://<name>.e2e.test:<port>/...` from `e2e/sites.ts` with `setRoute(host, path, handler)`
  - `article(url, title, overrides?)`, `feedItem(id, title, overrides?)`, `paper(id, title, overrides?)` builders in `e2e/seed.ts`

- [ ] **Step 1: Add the dependency and scripts**

```bash
npm install --save-dev axe-core
```
Why: automated WCAG checks (contrast, names, roles) are a well-maintained rule engine; hand-rolling them would be worse and larger.

In `package.json` `scripts`, add:
```json
"build:e2e": "E2E=1 npm run build",
"test:e2e": "vitest run --config vitest.e2e.config.ts",
```
and change `typecheck` to:
```json
"typecheck": "tsc --noEmit && tsc --noEmit -p e2e",
```

- [ ] **Step 2: Vitest config for the browser suite**

Create `vitest.e2e.config.ts`:
```ts
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
```

Create `e2e/tsconfig.json`:
```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": { "types": ["chrome", "node"] },
  "include": [".", "../vitest.e2e.config.ts"]
}
```

Append to `.gitignore`:
```
# Browser-suite screenshots and traces
e2e/out/
```

- [ ] **Step 3: A local web server for fake sites**

Every `*.e2e.test` hostname resolves to 127.0.0.1 (the harness passes `--host-resolver-rules`), so page and service-worker fetches both reach this server, and the `Host` header says which fake site was asked for.

Create `e2e/sites.ts`:
```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export interface Sites {
  port: number;
  /** `http://<host>.e2e.test:<port>` */
  origin(host: string): string;
  setRoute(host: string, path: string, handler: Handler): void;
  close(): Promise<void>;
}

export const html = (body: string, head = ''): Handler => (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="en"><head><title>t</title>${head}</head><body>${body}</body></html>`);
};

export const rss = (title: string, items: string[]): Handler => (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/rss+xml' });
  res.end(
    `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>http://x/</link>` +
      items.map((t, i) => `<item><title>${t}</title><link>http://x/${i}</link><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate></item>`).join('') +
      `</channel></rss>`,
  );
};

export const status = (code: number): Handler => (_req, res) => {
  res.writeHead(code, { 'content-type': 'text/plain' });
  res.end(String(code));
};

export async function startSites(): Promise<Sites> {
  const routes = new Map<string, Handler>();
  const server: Server = createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0].replace(/\.e2e\.test$/, '');
    const path = (req.url ?? '/').split('?')[0];
    (routes.get(`${host}${path}`) ?? status(404))(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    origin: (host) => `http://${host}.e2e.test:${port}`,
    setRoute: (host, path, handler) => routes.set(`${host}${path}`, handler),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 4: The harness**

Create `e2e/harness.ts`:
```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import { expect } from 'vitest';
import { A11Y_BASELINE } from './a11yBaseline';
import { startSites, type Sites } from './sites';

const DIST = resolve(__dirname, '..', 'dist');
export const OUT = resolve(__dirname, 'out');

export const PAGES = {
  newtab: 'src/pages/newtab/index.html',
  options: 'src/pages/options/index.html',
  papers: 'src/pages/papers/index.html',
  reader: 'src/pages/reader/index.html',
  blocked: 'src/pages/blocked/index.html#https://example.com/',
} as const;

export interface Ext {
  ctx: BrowserContext;
  sw: Worker;
  id: string;
  sites: Sites;
  /** Every console error and uncaught exception, from any page */
  errors: string[];
  /** Opens an extension page and waits for storage-driven UI to settle */
  page(path: string): Promise<Page>;
  close(): Promise<void>;
}

export async function launch(): Promise<Ext> {
  const sites = await startSites();
  const profile = mkdtempSync(join(tmpdir(), 'reader-e2e-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      `--host-resolver-rules=MAP *.e2e.test 127.0.0.1`,
      // The fake sites live on 127.0.0.1. Real feeds are on the public
      // internet, so Chrome's local-network checks never apply to users; here
      // they would only stand between the suite and its own server.
      '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights',
    ],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;

  const errors: string[] = [];
  ctx.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()} (${msg.location().url})`);
  });
  ctx.on('weberror', (err) => errors.push(`uncaught: ${err.error().message}`));

  // Let onInstalled (migrate, alarms) finish before a test seeds storage over it.
  await sw.evaluate(() => new Promise((r) => setTimeout(r, 300)));

  return {
    ctx,
    sw,
    id,
    sites,
    errors,
    async page(path) {
      const page = await ctx.newPage();
      await page.goto(`chrome-extension://${id}/${path}`);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(800);
      return page;
    },
    async close() {
      await ctx.close();
      await sites.close();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

export async function seed(ext: Ext, data: Record<string, unknown>): Promise<void> {
  await ext.sw.evaluate((d) => chrome.storage.local.set(d), data);
}

export async function storage<T>(ext: Ext, key: string): Promise<T> {
  return ext.sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key) as Promise<T>;
}

/**
 * Chrome logs a console error for every failed or 4xx/5xx fetch. Tests that
 * point at a dead Ollama port or an erroring fake site pass this to expectClean.
 */
export const NETWORK_NOISE = [/Failed to load resource/, /net::ERR_/];

/** Fails on any console error or uncaught exception not matched by `allow`. */
export function expectClean(ext: Ext, allow: RegExp[] = []): void {
  const unexpected = ext.errors.filter((e) => !allow.some((re) => re.test(e)));
  expect(unexpected).toEqual([]);
  ext.errors.length = 0;
}

const require = createRequire(__filename);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/**
 * WCAG 2.2 A/AA violations on the page as it is now. Injected through
 * page.evaluate, not a script tag: extension pages run under
 * `script-src 'self'`, which blocks inline scripts but not CDP evaluation.
 */
export async function axe(page: Page): Promise<{ id: string; nodes: number }[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const run = (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe.run;
    const result = await run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] });
    return result.violations.map((v) => ({ id: v.id, nodes: v.nodes.length }));
  });
}

/**
 * No violation outside the baseline, and no baselined violation that has gone
 * away (so the baseline only ever shrinks).
 */
export async function expectA11y(page: Page, pageName: string): Promise<void> {
  const found = (await axe(page)).map((v) => v.id).sort();
  const known = (A11Y_BASELINE[pageName] ?? []).map((k) => k.rule).sort();
  expect({ page: pageName, violations: found }).toEqual({ page: pageName, violations: known });
}

export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}

/** Wide content at 200% zoom: the page at half the width must not scroll sideways. */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
```

- [ ] **Step 5: Typed seed builders**

Create `e2e/seed.ts`:
```ts
import type { FeedItem, Paper, ReadingProgress } from '../src/shared/types';

const HOUR = 60 * 60_000;

export function article(url: string, title: string, overrides: Partial<ReadingProgress> = {}): ReadingProgress {
  const now = Date.now();
  return {
    kind: 'article',
    url,
    title,
    source: 'E2E Source',
    feedItemId: null,
    maxPercent: 40,
    scrollY: 1200,
    pageHeight: 6000,
    activeSeconds: 300,
    firstOpenedAt: now - 24 * HOUR,
    updatedAt: now - HOUR,
    completedAt: null,
    nudge: { count: 0, lastAt: 0, dismissed: false },
    ...overrides,
  };
}

export function feedItem(id: string, title: string, overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id,
    title,
    link: `http://news.e2e.test/${id}`,
    normalizedLink: `news.e2e.test/${id}`,
    pubDate: new Date(Date.now() - HOUR).toISOString(),
    snippet: '',
    source: 'E2E Feed',
    ...overrides,
  };
}

export function paper(id: string, title: string, overrides: Partial<Paper> = {}): Paper {
  const now = Date.now();
  return {
    id,
    deckId: 'e2e-deck',
    title,
    authors: 'A. Author',
    venue: 'E2E',
    year: 2026,
    citations: null,
    url: `https://arxiv.org/abs/2601.${id.padStart(5, '0')}`,
    abstract: `Abstract of ${title}.`,
    relevance: '',
    status: 'reading',
    progressPercent: 30,
    leftOff: '',
    addedAt: now - 48 * HOUR,
    updatedAt: now - HOUR,
    lastReadAt: now - HOUR,
    ...overrides,
  };
}

export const deck = { id: 'e2e-deck', name: 'E2E deck', kind: 'papers', createdAt: Date.now() };
```

- [ ] **Step 6: Empty a11y baseline**

Create `e2e/a11yBaseline.ts`:
```ts
/**
 * Accessibility violations that exist today and are accepted for now, per page.
 * expectA11y fails on anything not listed here AND on anything listed that no
 * longer occurs, so this list can only shrink. Every entry needs a reason.
 */
export const A11Y_BASELINE: Record<string, { rule: string; reason: string }[]> = {};
```

- [ ] **Step 7: Write the smoke regression suite**

Create `e2e/smoke.e2e.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGES, expectA11y, expectClean, horizontalOverflow, launch, seed, shot, type Ext } from './harness';
import { html } from './sites';
import { article, deck, paper } from './seed';

describe('smoke: every page renders, is accessible, and works with Chromium built-ins', () => {
  let ext: Ext;
  let leadUrl: string;

  beforeAll(async () => {
    ext = await launch();
    leadUrl = `${ext.sites.origin('article')}/post`;
    ext.sites.setRoute('article', '/post', html('<h1>An article</h1><p>Body.</p>'));
    await seed(ext, {
      readingProgress: {
        [leadUrl]: article(leadUrl, 'The lead story', { updatedAt: Date.now() - 60_000 }),
        [`${leadUrl}2`]: article(`${leadUrl}2`, 'The second story'),
      },
      decks: [deck],
      papers: [paper('1', 'A paper in progress')],
    });
  });
  afterAll(async () => ext.close());

  for (const [name, path] of Object.entries(PAGES)) {
    it(`${name}: no errors, declared language, no new a11y violations (light and dark)`, async () => {
      const page = await ext.page(path);
      expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
      await expectA11y(page, name);
      await page.emulateMedia({ colorScheme: 'dark' });
      await expectA11y(page, name);
      await shot(page, `smoke-${name}`);
      expectClean(ext);
      await page.close();
    });

    it(`${name}: reflows at 200% zoom without sideways scrolling`, async () => {
      const page = await ext.page(path);
      await page.setViewportSize({ width: 640, height: 900 });
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      expectClean(ext);
      await page.close();
    });

    it(`${name}: renders under forced colors and reduced motion`, async () => {
      const page = await ext.page(path);
      await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => document.body.innerText.length)).toBeGreaterThan(0);
      expectClean(ext);
      await page.close();
    });
  }

  it('new tab: the lead is first, J/K walk the stories, Enter opens the lead', async () => {
    const page = await ext.page(PAGES.newtab);
    const stories = page.locator('[data-story]');
    await expect.poll(() => stories.count()).toBeGreaterThanOrEqual(2);
    expect(await stories.first().innerText()).toContain('The lead story');

    await page.keyboard.press('j');
    expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-story'))).toBe(true);
    await page.keyboard.press('k');

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const opened = ext.ctx.waitForEvent('page');
    await page.keyboard.press('Enter');
    const tab = await opened;
    await tab.waitForLoadState();
    expect(tab.url()).toBe(leadUrl);
    expectClean(ext);
    await tab.close();
    await page.close();
  });

  it('blocked page: outside a focus session it offers the way back', async () => {
    const page = await ext.page(PAGES.blocked);
    await expect.poll(() => page.locator('h1').innerText()).toBe('Focus session over');
    expect(await page.locator('a.blocked-continue').getAttribute('href')).toBe('https://example.com/');
    expectClean(ext);
    await page.close();
  });
});
```

- [ ] **Step 8: Build and run it; settle the a11y baseline**

Run: `npm run build:e2e && npm run test:e2e`
Expected: every test PASS, or `expectA11y` failures listing rule ids for some pages.

If `expectA11y` fails, decide per rule:
- A real, small defect (missing label, contrast on one element): fix it in this task and re-run.
- Not fixable here: add `{ rule: '<id>', reason: '<why it is accepted, one line>' }` under that page name in `e2e/a11yBaseline.ts`.

Re-run until PASS. Any other failure is a real regression in existing code: debug it (superpowers:systematic-debugging) before continuing.

- [ ] **Step 9: Add the CI job**

In `.github/workflows/ci.yml`, add after the `check` job:
```yaml
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run build:e2e
      - run: npm run test:e2e
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-screenshots
          path: e2e/out/
```

- [ ] **Step 10: Run the full local gate**

Run: `npm run typecheck && npm test && npm run build && npm run build:e2e && npm run test:e2e`
Expected: all PASS.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json vitest.e2e.config.ts e2e .github/workflows/ci.yml .gitignore
git commit -m "Drive the built extension in Chromium in CI

A browser suite under Vitest + Playwright: every page renders with no
console errors, a declared language, no WCAG 2.2 AA violations outside a
shrink-only baseline (light and dark), reflow at 200% zoom, forced colors
and reduced motion; J/K/Enter on the new tab. Adds axe-core as a dev
dependency for the WCAG rules.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Rank sites from history and find feed links in a page

**Files:**
- Create: `src/shared/feedDiscovery.ts`, `src/shared/feedDiscovery.test.ts`

**Interfaces:**
- Produces:
  - `interface HistoryVisit { url?: string; title?: string; lastVisitTime?: number; visitCount?: number }`
  - `interface SiteScore { host: string; origin: string; visits: number; pages: number; lastVisit: number; score: number }`
  - `rankDomains(items: readonly HistoryVisit[], now: number, days: number): SiteScore[]`
  - `feedLinks(html: string, base: string): string[]`
  - `const MIN_VISITS = 2`, `const DAY = 86_400_000`

- [ ] **Step 1: Write the failing tests**

Create `src/shared/feedDiscovery.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DAY, feedLinks, rankDomains, type HistoryVisit } from './feedDiscovery';

const now = Date.parse('2026-10-08T12:00:00Z');
const visit = (url: string, visitCount = 1, ago = 0): HistoryVisit => ({ url, visitCount, lastVisitTime: now - ago });

describe('rankDomains', () => {
  it('groups by host, strips www, and keeps ports apart', () => {
    const sites = rankDomains(
      [
        visit('https://www.lwn.net/a', 3),
        visit('https://lwn.net/b', 2),
        visit('http://127.0.0.1:8080/x', 2),
        visit('http://127.0.0.1:9090/y', 2),
      ],
      now,
      7,
    );
    expect(sites.map((s) => [s.host, s.visits, s.pages])).toEqual([
      ['lwn.net', 5, 2],
      ['127.0.0.1:8080', 2, 1],
      ['127.0.0.1:9090', 2, 1],
    ]);
  });

  it('drops sites under two visits, non-web schemes and malformed URLs', () => {
    const sites = rankDomains(
      [visit('https://once.example/', 1), visit('chrome://settings', 9), visit('file:///x.pdf', 9), { url: 'not a url', visitCount: 9 }, {}],
      now,
      7,
    );
    expect(sites).toEqual([]);
  });

  it('counts a missing or zero visitCount as one visit', () => {
    const sites = rankDomains([{ url: 'https://a.example/1', lastVisitTime: now }, { url: 'https://a.example/2', visitCount: 0, lastVisitTime: now }], now, 7);
    expect(sites[0].visits).toBe(2);
  });

  it('fetches from the origin of the most recent visit', () => {
    const sites = rankDomains([visit('http://site.example/old', 2, 3 * DAY), visit('https://site.example/new', 1, 0)], now, 7);
    expect(sites[0].origin).toBe('https://site.example');
  });

  it('ranks frequent, recent, varied sites first and breaks ties by host', () => {
    const sites = rankDomains(
      [
        ...Array.from({ length: 10 }, (_, i) => visit(`https://busy.example/${i}`, 5, 0)),
        visit('https://stale.example/a', 30, 6 * DAY),
        visit('https://b.example/', 2, DAY),
        visit('https://a.example/', 2, DAY),
      ],
      now,
      7,
    );
    expect(sites.map((s) => s.host)).toEqual(['busy.example', 'stale.example', 'a.example', 'b.example']);
  });

  it('ranks 10,000 history items in well under a quarter second', () => {
    const items = Array.from({ length: 10_000 }, (_, i) => visit(`https://site${i % 600}.example/p${i}`, (i % 7) + 1, (i % 7) * DAY));
    const start = performance.now();
    rankDomains(items, now, 7);
    // ponytail: wall-clock budget with ~10x headroom for slow CI runners.
    expect(performance.now() - start).toBeLessThan(250);
  });
});

describe('feedLinks', () => {
  const base = 'https://blog.example/posts/';

  it('finds RSS and Atom alternates and resolves relative hrefs', () => {
    const html = `<head>
      <link rel="alternate" type="application/rss+xml" href="/feed.xml">
      <link rel='alternate' TYPE='Application/Atom+XML' href='atom.xml'>
    </head>`;
    expect(feedLinks(html, base)).toEqual(['https://blog.example/feed.xml', 'https://blog.example/posts/atom.xml']);
  });

  it('ignores alternates that are not feeds and links that are not alternates', () => {
    const html = `<link rel="alternate" hreflang="de" type="text/html" href="/de/">
      <link rel="stylesheet" type="application/rss+xml" href="/x.xml">
      <link rel="alternate" type="application/rss+xml">`;
    expect(feedLinks(html, base)).toEqual([]);
  });

  it('accepts rel lists, unquoted attributes and HTML entities in hrefs', () => {
    const html = `<link rel="home alternate" type=application/rss+xml href="/feed?a=1&amp;b=2">`;
    expect(feedLinks(html, base)).toEqual(['https://blog.example/feed?a=1&b=2']);
  });

  it('respects a <base href> and drops non-web schemes and duplicates', () => {
    const html = `<base href="https://cdn.example/root/">
      <link rel="alternate" type="application/rss+xml" href="feed.xml">
      <link rel="alternate" type="application/rss+xml" href="https://cdn.example/root/feed.xml">
      <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">`;
    expect(feedLinks(html, base)).toEqual(['https://cdn.example/root/feed.xml']);
  });

  it('scans a 2 MB page quickly', () => {
    const html = `<link rel="alternate" type="application/rss+xml" href="/f.xml">` + '<p>filler</p>'.repeat(170_000);
    const start = performance.now();
    expect(feedLinks(html, base)).toHaveLength(1);
    expect(performance.now() - start).toBeLessThan(150);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/shared/feedDiscovery.test.ts`
Expected: FAIL, `Failed to resolve import "./feedDiscovery"`.

- [ ] **Step 3: Implement**

Create `src/shared/feedDiscovery.ts`:
```ts
/**
 * Feed suggestions from browsing history (idea from ThariqS/ai-newtab, kept on
 * the machine): the sites you actually visit are better suggestions than any
 * sample list, and most of them already say where their feed is.
 *
 * Pure parts first; the browser IO is injected further down so every failure
 * path is a unit test.
 */

export const DAY = 24 * 60 * 60_000;
/** A site seen once is a link someone sent you, not something you follow. */
export const MIN_VISITS = 2;

export interface HistoryVisit {
  url?: string;
  title?: string;
  lastVisitTime?: number;
  visitCount?: number;
}

export interface SiteScore {
  /** Host without `www.`, port kept: 127.0.0.1:8080 and :9090 are different sites */
  host: string;
  /** Origin of the most recent visit; the front page is fetched from here */
  origin: string;
  /** Sum of visitCount, which Chrome counts over all time per URL */
  visits: number;
  pages: number;
  lastVisit: number;
  score: number;
}

/**
 * Relevance = frequency 40% + recency 30% + page variety 20% + visits per day
 * 10%, each capped at 1 (ai-newtab lib/history.ts). Ties go to the host name so
 * the order is stable.
 */
export function rankDomains(items: readonly HistoryVisit[], now: number, days: number): SiteScore[] {
  const sites = new Map<string, SiteScore>();
  const pagesSeen = new Map<string, Set<string>>();
  for (const item of items) {
    if (!item.url) continue;
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const host = url.host.replace(/^www\./, '');
    let site = sites.get(host);
    if (!site) {
      site = { host, origin: url.origin, visits: 0, pages: 0, lastVisit: 0, score: 0 };
      sites.set(host, site);
      pagesSeen.set(host, new Set());
    }
    site.visits += Math.max(1, item.visitCount ?? 1);
    const pages = pagesSeen.get(host)!;
    if (!pages.has(item.url)) {
      pages.add(item.url);
      site.pages++;
    }
    const last = item.lastVisitTime ?? 0;
    if (last >= site.lastVisit) {
      site.lastVisit = last;
      site.origin = url.origin;
    }
  }

  const span = Math.max(1, days);
  const ranked = [...sites.values()].filter((s) => s.visits >= MIN_VISITS);
  for (const site of ranked) {
    const recency = Math.max(0, 1 - (now - site.lastVisit) / (span * DAY));
    site.score =
      Math.min(site.visits / 50, 1) * 0.4 +
      recency * 0.3 +
      Math.min(site.pages / 10, 1) * 0.2 +
      Math.min(site.visits / span / 5, 1) * 0.1;
  }
  return ranked.sort((a, b) => b.score - a.score || a.host.localeCompare(b.host));
}

const FEED_TYPE = /^application\/(rss|atom)\+xml$/i;
const LINK_TAG = /<link\b[^>]*>/gi;
const BASE_TAG = /<base\b[^>]*>/i;
const ATTR = /([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

const decodeEntities = (s: string) => s.replace(/&amp;|&#38;|&#x26;/gi, '&');

function webUrl(href: string, base: string): string | null {
  try {
    const url = new URL(decodeEntities(href), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Every feed a page advertises (`<link rel="alternate" type="application/rss+xml">`
 * or Atom), absolute, deduplicated, in page order. Regex rather than DOMParser
 * because the service worker has no DOM, and only `<link>` tags matter.
 */
export function feedLinks(html: string, base: string): string[] {
  const baseHref = attributes(BASE_TAG.exec(html)?.[0] ?? '').href;
  const root = (baseHref && webUrl(baseHref, base)) || base;
  const out = new Set<string>();
  for (const [tag] of html.matchAll(LINK_TAG)) {
    const attrs = attributes(tag);
    if (!/(^|\s)alternate(\s|$)/i.test(attrs.rel ?? '')) continue;
    if (!FEED_TYPE.test((attrs.type ?? '').trim())) continue;
    if (!attrs.href) continue;
    const href = webUrl(attrs.href, root);
    if (href) out.add(href);
  }
  return [...out];
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/shared/feedDiscovery.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/feedDiscovery.ts src/shared/feedDiscovery.test.ts
git commit -m "Rank sites from history and read the feeds a page advertises

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The discovery run, with timeouts, caps, cancellation and honest counts

**Files:**
- Modify: `src/shared/feedDiscovery.ts`, `src/shared/feedDiscovery.test.ts`

**Interfaces:**
- Consumes: `rankDomains`, `feedLinks`, `DAY` (Task 3)
- Produces:
  - `const DISCOVERY = { days: 7, sites: 12, concurrency: 4, timeoutMs: 8000, maxBytes: 524_288 }`
  - `interface FetchedPage { url: string; status: number; text: string }`
  - `fetchCapped(url: string, signal: AbortSignal, maxBytes?: number): Promise<FetchedPage>`
  - `interface DiscoveryDeps { searchHistory(startTime: number): Promise<HistoryVisit[]>; fetchPage(url: string, signal: AbortSignal): Promise<FetchedPage>; now(): number; timeoutMs?: number }`
  - `interface Suggestion { feedUrl: string; host: string; visits: number }`
  - `interface DiscoveryResult { suggestions: Suggestion[]; checked: number; unreachable: number }`
  - `suggestFeeds(deps: DiscoveryDeps, followedFeeds: readonly string[], signal: AbortSignal): Promise<DiscoveryResult>`
  - `isFollowed(host: string, followedHosts: readonly string[]): boolean`
  - `withScheme(input: string): string | null`
  - `findFeedOnPage(url: string, fetchPage?: (url: string, signal: AbortSignal) => Promise<FetchedPage>): Promise<string | null>`

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/feedDiscovery.test.ts` (and add `fetchCapped, findFeedOnPage, isFollowed, suggestFeeds, withScheme, type DiscoveryDeps, type FetchedPage` to the import from `./feedDiscovery`, plus `vi` and `afterEach` to the vitest import):
```ts
const page = (url: string, body: string, status = 200): FetchedPage => ({ url, status, text: body });
const feedPage = (url: string, href: string) => page(url, `<link rel="alternate" type="application/rss+xml" href="${href}">`);

function deps(history: HistoryVisit[], pages: Record<string, () => Promise<FetchedPage>>, extra: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
  return {
    now: () => now,
    searchHistory: async () => history,
    fetchPage: async (url) => {
      const make = pages[url];
      if (!make) throw new TypeError('Failed to fetch');
      return make();
    },
    ...extra,
  };
}

const twice = (url: string) => [visit(url, 3, 0), visit(`${url}x`, 3, 0)];

describe('suggestFeeds', () => {
  it('suggests one feed per site in rank order, with the visit count', async () => {
    const result = await suggestFeeds(
      deps([...twice('https://a.example/'), visit('https://b.example/', 2, DAY)], {
        'https://a.example/': async () => feedPage('https://a.example/', '/rss'),
        'https://b.example/': async () => feedPage('https://b.example/', '/atom.xml'),
      }),
      [],
      new AbortController().signal,
    );
    expect(result).toEqual({
      suggestions: [
        { feedUrl: 'https://a.example/rss', host: 'a.example', visits: 6 },
        { feedUrl: 'https://b.example/atom.xml', host: 'b.example', visits: 2 },
      ],
      checked: 2,
      unreachable: 0,
    });
  });

  it('subdomain feeds count as followed, in both directions', () => {
    expect(isFollowed('arstechnica.com', ['feeds.arstechnica.com'])).toBe(true);
    expect(isFollowed('blog.example.com', ['example.com'])).toBe(true);
    expect(isFollowed('notexample.com', ['example.com'])).toBe(false);
  });

  it('skips followed sites and feeds, and the same feed reached from two sites', async () => {
    const result = await suggestFeeds(
      deps([...twice('https://a.example/'), ...twice('https://b.example/'), ...twice('https://arstechnica.com/')], {
        'https://a.example/': async () => feedPage('https://a.example/', 'https://shared.example/feed'),
        'https://b.example/': async () => feedPage('https://b.example/', 'https://shared.example/feed'),
      }),
      ['https://feeds.arstechnica.com/arstechnica/index'],
      new AbortController().signal,
    );
    expect(result.suggestions.map((s) => s.feedUrl)).toEqual(['https://shared.example/feed']);
    expect(result.checked).toBe(2);
  });

  it('counts failures and error statuses as unreachable and keeps the rest', async () => {
    const result = await suggestFeeds(
      deps([...twice('https://a.example/'), ...twice('https://down.example/'), ...twice('https://gone.example/')], {
        'https://a.example/': async () => feedPage('https://a.example/', '/rss'),
        'https://gone.example/': async () => page('https://gone.example/', 'nope', 404),
      }),
      [],
      new AbortController().signal,
    );
    expect(result.suggestions).toHaveLength(1);
    expect(result).toMatchObject({ checked: 3, unreachable: 2 });
  });

  it('a redirect to a page with no feed link is checked, not unreachable', async () => {
    const result = await suggestFeeds(
      deps(twice('https://news.example/'), {
        'https://news.example/': async () => page('https://consent.example/?continue=news', '<form>Accept cookies</form>'),
      }),
      [],
      new AbortController().signal,
    );
    expect(result).toEqual({ suggestions: [], checked: 1, unreachable: 0 });
  });

  it('a site that never answers times out and counts as unreachable', async () => {
    const hang = (_url: string, signal: AbortSignal) =>
      new Promise<FetchedPage>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    const result = await suggestFeeds(
      { ...deps(twice('https://slow.example/'), {}), fetchPage: hang, timeoutMs: 20 },
      [],
      new AbortController().signal,
    );
    expect(result).toEqual({ suggestions: [], checked: 1, unreachable: 1 });
  });

  it('abort stops the scan and rejects with an AbortError', async () => {
    const controller = new AbortController();
    let calls = 0;
    const history = Array.from({ length: 12 }, (_, i) => twice(`https://s${i}.example/`)).flat();
    const fetchPage = (_url: string, signal: AbortSignal) => {
      calls++;
      if (calls === 2) controller.abort();
      return new Promise<FetchedPage>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    };
    await expect(suggestFeeds({ ...deps(history, {}), fetchPage }, [], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBeLessThanOrEqual(4);
  });

  it('never has more than four requests in flight and checks at most twelve sites', async () => {
    let inFlight = 0;
    let peak = 0;
    const history = Array.from({ length: 20 }, (_, i) => twice(`https://s${i}.example/`)).flat();
    const fetchPage = async (url: string) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return page(url, '');
    };
    const result = await suggestFeeds({ ...deps(history, {}), fetchPage }, [], new AbortController().signal);
    expect(peak).toBeLessThanOrEqual(4);
    expect(result.checked).toBe(12);
  });

  it('empty history checks nothing', async () => {
    expect(await suggestFeeds(deps([], {}), [], new AbortController().signal)).toEqual({ suggestions: [], checked: 0, unreachable: 0 });
  });
});

describe('fetchCapped', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('omits credentials and stops reading at the byte cap', async () => {
    const init: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
      init.push(options);
      return new Response('x'.repeat(2_000_000), { status: 200 });
    });
    const result = await fetchCapped('https://big.example/', new AbortController().signal, 100_000);
    expect(init[0].credentials).toBe('omit');
    expect(result.text.length).toBeLessThan(200_000);
    expect(result.status).toBe(200);
  });
});

describe('withScheme', () => {
  it('adds https to a bare site, keeps explicit http(s), rejects the rest', () => {
    expect(withScheme('lwn.net')).toBe('https://lwn.net/');
    expect(withScheme('  http://site.example/feed ')).toBe('http://site.example/feed');
    expect(withScheme('localhost:8080')).toBe('https://localhost:8080/');
    expect(withScheme('')).toBeNull();
    expect(withScheme('not a site')).toBeNull();
    expect(withScheme('ftp://x.example/')).toBeNull();
    expect(withScheme('javascript:alert(1)')).toBeNull();
  });
});

describe('findFeedOnPage', () => {
  it('returns the first advertised feed, or null on failure or error status', async () => {
    expect(await findFeedOnPage('https://a.example/', async (url) => feedPage(url, '/rss'))).toBe('https://a.example/rss');
    expect(await findFeedOnPage('https://a.example/', async (url) => page(url, '', 500))).toBeNull();
    expect(await findFeedOnPage('https://a.example/', async () => { throw new TypeError('Failed to fetch'); })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/shared/feedDiscovery.test.ts`
Expected: FAIL, `suggestFeeds is not a function` (and the other new names).

- [ ] **Step 3: Implement**

Append to `src/shared/feedDiscovery.ts`:
```ts
/** How far one "Suggest from my history" run goes. */
export const DISCOVERY = {
  days: 7,
  sites: 12,
  concurrency: 4,
  timeoutMs: 8000,
  /** Feed links live in <head>; half a megabyte is far past it on any real page */
  maxBytes: 512 * 1024,
};

export interface FetchedPage {
  /** Final URL after redirects; relative feed links resolve against it */
  url: string;
  status: number;
  text: string;
}

/**
 * GET a page without cookies, reading at most `maxBytes`. Cookies are omitted
 * so a suggestion never depends on, or reveals, a signed-in session.
 */
export async function fetchCapped(url: string, signal: AbortSignal, maxBytes = DISCOVERY.maxBytes): Promise<FetchedPage> {
  const res = await fetch(url, {
    signal,
    credentials: 'omit',
    redirect: 'follow',
    headers: { accept: 'text/html,application/xhtml+xml' },
  });
  let text = '';
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (bytes < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  return { url: res.url || url, status: res.status, text };
}

export interface DiscoveryDeps {
  searchHistory(startTime: number): Promise<HistoryVisit[]>;
  fetchPage(url: string, signal: AbortSignal): Promise<FetchedPage>;
  now(): number;
  /** Per-site timeout; DISCOVERY.timeoutMs unless a test needs it short */
  timeoutMs?: number;
}

export interface Suggestion {
  feedUrl: string;
  host: string;
  visits: number;
}

export interface DiscoveryResult {
  suggestions: Suggestion[];
  /** Sites whose front page was asked for */
  checked: number;
  /** Of those, how many failed, timed out or answered with an error status */
  unreachable: number;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** feeds.arstechnica.com follows arstechnica.com, and the other way round. */
export function isFollowed(host: string, followedHosts: readonly string[]): boolean {
  return followedHosts.some((f) => f === host || f.endsWith(`.${host}`) || host.endsWith(`.${f}`));
}

async function pool<T>(items: readonly T[], size: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      await run(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

/**
 * Rank the last week of history, skip what is already followed, read the top
 * sites' front pages, and keep the first feed each one advertises. Results are
 * in rank order whatever order the fetches finish in. Aborting rejects with
 * the signal's AbortError; a single site failing never does.
 */
export async function suggestFeeds(
  deps: DiscoveryDeps,
  followedFeeds: readonly string[],
  signal: AbortSignal,
): Promise<DiscoveryResult> {
  const now = deps.now();
  const history = await deps.searchHistory(now - DISCOVERY.days * DAY);
  signal.throwIfAborted();

  const followed = new Set(followedFeeds);
  const followedHosts = followedFeeds.map(hostOf).filter((h): h is string => h !== null);
  const sites = rankDomains(history, now, DISCOVERY.days)
    .filter((s) => !isFollowed(s.host, followedHosts))
    .slice(0, DISCOVERY.sites);

  const found: (string | null)[] = sites.map(() => null);
  let unreachable = 0;
  await pool(sites, DISCOVERY.concurrency, async (site, i) => {
    signal.throwIfAborted();
    try {
      const timeout = AbortSignal.timeout(deps.timeoutMs ?? DISCOVERY.timeoutMs);
      const fetched = await deps.fetchPage(`${site.origin}/`, AbortSignal.any([signal, timeout]));
      if (fetched.status >= 400) {
        unreachable++;
        return;
      }
      found[i] = feedLinks(fetched.text, fetched.url).find((f) => !followed.has(f)) ?? null;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      unreachable++;
    }
  });
  signal.throwIfAborted();

  const seen = new Set<string>();
  const suggestions: Suggestion[] = [];
  sites.forEach((site, i) => {
    const feedUrl = found[i];
    if (!feedUrl || seen.has(feedUrl)) return;
    seen.add(feedUrl);
    suggestions.push({ feedUrl, host: site.host, visits: site.visits });
  });
  return { suggestions, checked: sites.length, unreachable };
}

/**
 * What someone typed into Add Feed, as an http(s) URL: `lwn.net` becomes
 * `https://lwn.net/`. Anything that is not a plausible web address is null.
 */
export function withScheme(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    const plausibleHost = url.hostname.includes('.') || url.hostname === 'localhost';
    return (url.protocol === 'http:' || url.protocol === 'https:') && plausibleHost && !/\s/.test(trimmed) ? url.href : null;
  } catch {
    return null;
  }
}

/** The first feed a page links to, or null if it links none or cannot be read. */
export async function findFeedOnPage(
  url: string,
  fetchPage: (url: string, signal: AbortSignal) => Promise<FetchedPage> = fetchCapped,
): Promise<string | null> {
  try {
    const fetched = await fetchPage(url, AbortSignal.timeout(DISCOVERY.timeoutMs));
    return fetched.status < 400 ? (feedLinks(fetched.text, fetched.url)[0] ?? null) : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/shared/feedDiscovery.test.ts`
Expected: PASS (23 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` (expected: no errors), then:
```bash
git add src/shared/feedDiscovery.ts src/shared/feedDiscovery.test.ts
git commit -m "Discovery run: capped, cookie-free fetches with timeouts and cancellation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Suggested feeds in Options, and Add Feed that accepts a site

**Files:**
- Create: `src/pages/options/SuggestedFeeds.tsx`, `src/pages/options/SuggestedFeeds.test.ts`, `e2e/suggestions.e2e.ts`
- Modify: `manifest.config.ts`, `src/pages/options/Options.tsx:40-67,150-171,335-352`, `src/pages/options/options.css:296-311`

**Interfaces:**
- Consumes: `suggestFeeds`, `fetchCapped`, `findFeedOnPage`, `withScheme`, `type DiscoveryResult`, `type Suggestion` (Task 4); `launch`, `seed`, `storage`, `expectClean`, `expectA11y`, `horizontalOverflow`, `PAGES`, `html`, `rss`, `status` (Task 2)
- Produces:
  - `type Scan = { state: 'idle' } | { state: 'scanning' } | { state: 'done'; result: DiscoveryResult } | { state: 'denied' } | { state: 'error'; message: string }`
  - `statusText(scan: Scan): string`
  - `SuggestedFeeds({ feeds, onAdd }: { feeds: string[]; onAdd: (url: string) => Promise<void> })`

- [ ] **Step 1: Write the failing test for the status copy**

Create `src/pages/options/SuggestedFeeds.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { statusText } from './SuggestedFeeds';

const done = (suggestions: number, checked: number, unreachable: number) => ({
  state: 'done' as const,
  result: {
    suggestions: Array.from({ length: suggestions }, (_, i) => ({ feedUrl: `https://s${i}.example/rss`, host: `s${i}.example`, visits: 3 })),
    checked,
    unreachable,
  },
});

describe('statusText', () => {
  it('says what was found, out of how many sites, and what could not be reached', () => {
    expect(statusText(done(2, 12, 0))).toBe('Found 2 feeds on the 12 sites you visit most.');
    expect(statusText(done(1, 12, 3))).toBe("Found 1 feed on the 12 sites you visit most. 3 couldn't be reached.");
  });

  it('tells apart no history, no feeds, and no connection', () => {
    expect(statusText(done(0, 0, 0))).toBe('Not enough browsing in the last 7 days to suggest anything yet.');
    expect(statusText(done(0, 12, 2))).toBe("None of the 12 sites you visit most publish a feed. 2 couldn't be reached.");
    expect(statusText(done(0, 5, 5))).toBe("Couldn't reach any of the 5 sites you visit most. Check your connection and try again.");
  });

  it('explains a declined permission without blame, and passes errors through', () => {
    expect(statusText({ state: 'denied' })).toBe(
      'Suggestions need access to your history. It is read on this computer only; nothing is stored or sent.',
    );
    expect(statusText({ state: 'error', message: "You're offline." })).toBe("You're offline.");
    expect(statusText({ state: 'scanning' })).toBe('Checking the sites you visit most...');
    expect(statusText({ state: 'idle' })).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/pages/options/SuggestedFeeds.test.ts`
Expected: FAIL, cannot resolve `./SuggestedFeeds`.

- [ ] **Step 3: Implement the component**

Create `src/pages/options/SuggestedFeeds.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react';
import { SAMPLE_FEEDS } from '../../shared/constants';
import { DISCOVERY, fetchCapped, suggestFeeds, type DiscoveryResult } from '../../shared/feedDiscovery';

export type Scan =
  | { state: 'idle' }
  | { state: 'scanning' }
  | { state: 'done'; result: DiscoveryResult }
  | { state: 'denied' }
  | { state: 'error'; message: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The one line under the button. Pure, so every case is a unit test. */
export function statusText(scan: Scan): string {
  switch (scan.state) {
    case 'idle':
      return '';
    case 'scanning':
      return 'Checking the sites you visit most...';
    case 'denied':
      return 'Suggestions need access to your history. It is read on this computer only; nothing is stored or sent.';
    case 'error':
      return scan.message;
    case 'done': {
      const { suggestions, checked, unreachable } = scan.result;
      const sites = `${plural(checked, 'site', 'sites')} you visit most`;
      const missed = unreachable > 0 ? ` ${unreachable} couldn't be reached.` : '';
      if (checked === 0) return `Not enough browsing in the last ${DISCOVERY.days} days to suggest anything yet.`;
      if (suggestions.length > 0) return `Found ${plural(suggestions.length, 'feed', 'feeds')} on the ${sites}.${missed}`;
      if (unreachable === checked) return `Couldn't reach any of the ${sites}. Check your connection and try again.`;
      return `None of the ${sites} publish a feed.${missed}`;
    }
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Feeds from the sites you already visit, found on request. History is read
 * here, in the page, only after Chrome's permission prompt; nothing is kept.
 * The static sample feeds stay underneath for a fresh profile with no history.
 */
export function SuggestedFeeds({ feeds, onAdd }: { feeds: string[]; onAdd: (url: string) => Promise<void> }) {
  const [scan, setScan] = useState<Scan>({ state: 'idle' });
  const controller = useRef<AbortController | null>(null);

  // Leaving Settings mid-scan stops the fetches and every state update after it.
  useEffect(() => () => controller.current?.abort(), []);

  const run = async () => {
    // Chrome shows the permission prompt only inside the click, so this is the
    // first await. Re-asked every time: the grant can be revoked from
    // chrome://extensions between clicks.
    let granted: boolean;
    try {
      granted = await chrome.permissions.request({ permissions: ['history'] });
    } catch (error) {
      setScan({ state: 'error', message: `Chrome would not ask for history access: ${messageOf(error)}` });
      return;
    }
    if (!granted || !chrome.history) {
      setScan({ state: 'denied' });
      return;
    }
    if (!navigator.onLine) {
      setScan({ state: 'error', message: "You're offline. Connect and try again." });
      return;
    }
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    setScan({ state: 'scanning' });
    try {
      const result = await suggestFeeds(
        {
          now: Date.now,
          searchHistory: (startTime) => chrome.history.search({ text: '', startTime, maxResults: 10_000 }),
          fetchPage: fetchCapped,
        },
        feeds,
        ctrl.signal,
      );
      if (!ctrl.signal.aborted) setScan({ state: 'done', result });
    } catch (error) {
      if (ctrl.signal.aborted) return;
      setScan({ state: 'error', message: `Couldn't read your history: ${messageOf(error)}` });
    }
  };

  const cancel = () => {
    controller.current?.abort();
    setScan({ state: 'idle' });
  };

  const suggestions = scan.state === 'done' ? scan.result.suggestions : [];

  return (
    <section className="section" id="sample-feeds">
      <h2>Suggested Feeds</h2>
      <div className="suggest-row">
        {scan.state === 'scanning' ? (
          <button type="button" className="secondary-btn" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button type="button" className="secondary-btn" onClick={() => void run()}>
            Suggest from my history
          </button>
        )}
      </div>
      {/* Always mounted: a live region only announces changes it was present for. */}
      <p className="hint" role="status" aria-live="polite">
        {statusText(scan)}
      </p>
      {suggestions.length > 0 && (
        <div className="sample-feeds">
          {suggestions.map((s) => {
            const following = feeds.includes(s.feedUrl);
            return (
              // aria-disabled, not disabled: a disabled button drops keyboard
              // focus to <body> the moment the feed is added.
              <button
                type="button"
                key={s.feedUrl}
                className="sample-feed"
                aria-disabled={following}
                title={s.feedUrl}
                onClick={() => !following && void onAdd(s.feedUrl)}
              >
                {following ? `Following ${s.host}` : `${s.host} · visited ${s.visits} times`}
              </button>
            );
          })}
        </div>
      )}
      <p className="hint">Or start with a popular feed:</p>
      <div className="sample-feeds">
        {SAMPLE_FEEDS.map((feed) => (
          <button type="button" key={feed.url} className="sample-feed" onClick={() => void onAdd(feed.url)}>
            {feed.name}
          </button>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run src/pages/options/SuggestedFeeds.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire it into Options, and let Add Feed take a site**

In `src/pages/options/Options.tsx`:

Add imports:
```ts
import { findFeedOnPage, withScheme } from '../../shared/feedDiscovery';
import { SuggestedFeeds } from './SuggestedFeeds';
```
Remove `SAMPLE_FEEDS` from the `../../shared/constants` import (keep `HYPERFOCUS_MINUTES`).

Replace the whole `addFeed` function with:
```ts
  const addFeed = async (input: string) => {
    const typed = withScheme(input);
    if (!typed) {
      flash('Enter a web address, like lwn.net or https://lwn.net/feed.', 'error');
      return;
    }
    if (feeds.includes(typed)) {
      flash('This feed is already added.', 'error');
      return;
    }
    setFeedback({ text: 'Checking the feed...', kind: 'loading' });
    let feedUrl = typed;
    let res = await sendMessage({ type: 'VALIDATE_FEED', url: feedUrl });
    if (!res?.valid) {
      // Not a feed itself: most sites say where theirs is.
      setFeedback({ text: 'Looking for a feed on that page...', kind: 'loading' });
      const found = await findFeedOnPage(typed);
      if (found && found !== typed) {
        feedUrl = found;
        res = await sendMessage({ type: 'VALIDATE_FEED', url: feedUrl });
      }
    }
    if (!res?.valid) {
      flash("Couldn't find a feed there. Check the address, or paste the feed's own URL.", 'error');
      return;
    }
    // Re-read rather than write back the list this render captured: validation
    // above is a network round-trip, so the snapshot can be stale by now.
    const { feeds: live } = await getLocal('feeds');
    if (live.includes(feedUrl)) {
      flash('This feed is already added.', 'error');
      return;
    }
    await setLocal({ feeds: [...live, feedUrl] });
    flash(res.title ? `Added "${res.title}"` : 'Feed added.', 'success');
    void sendMessage({ type: 'REFRESH_FEEDS' });
  };
```

In the Add New Feed form, change the input so a bare site passes the browser's own validation:
```tsx
            <input
              type="text"
              inputMode="url"
              autoComplete="off"
              aria-label="Feed or site address"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="lwn.net, or a feed URL like https://lwn.net/headlines/rss"
              required
            />
```
and make the feedback a live region:
```tsx
          {feedback && (
            <p className={`feedback ${feedback.kind}`} role="status" aria-live="polite">
              {feedback.text}
            </p>
          )}
```

Replace the whole `<section className="section" id="sample-feeds">...</section>` block with:
```tsx
        <SuggestedFeeds feeds={feeds} onAdd={addFeed} />
```

- [ ] **Step 6: Chip styles that survive forced colors**

In `src/pages/options/options.css`, in `.sample-feed`, replace `border: none;` with:
```css
  /* Transparent, not none: Windows High Contrast paints transparent borders,
     so the chip keeps an edge in forced colors. */
  border: 1px solid transparent;
```
and append after `.sample-feed:hover { ... }`:
```css
.sample-feed[aria-disabled='true'] {
  background: var(--bg-surface);
  color: var(--text-muted);
  cursor: default;
}

.suggest-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
```

- [ ] **Step 7: Make `history` an optional permission**

In `manifest.config.ts`, after `const crxKey = ...` add:
```ts
  // Playwright cannot click Chrome's permission prompt, so the E2E build grants
  // history up front. Every other build asks for it on click, in Settings.
  const e2e = vars.E2E === '1';
```
In `permissions`, after `'contextMenus',` add:
```ts
      ...(e2e ? (['history'] as const) : []),
```
and after the `permissions` array add:
```ts
    // Read only when you click "Suggest from my history" in Settings.
    ...(e2e ? {} : { optional_permissions: ['history' as const] }),
```

- [ ] **Step 8: Write the browser tests**

Create `e2e/suggestions.e2e.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NETWORK_NOISE, PAGES, expectA11y, expectClean, horizontalOverflow, launch, storage, type Ext } from './harness';
import { html, rss, status } from './sites';

describe('suggested feeds', () => {
  let ext: Ext;
  const visits: [string, number][] = [];

  beforeAll(async () => {
    ext = await launch();
    const o = (h: string) => ext.sites.origin(h);
    ext.sites.setRoute('alpha', '/', html('<h1>Alpha</h1>', '<link rel="alternate" type="application/rss+xml" href="/feed.xml">'));
    ext.sites.setRoute('alpha', '/feed.xml', rss('Alpha Feed', ['a1', 'a2']));
    ext.sites.setRoute('beta', '/', html('<h1>Beta</h1>', '<link rel="alternate" type="application/atom+xml" href="/atom">'));
    ext.sites.setRoute('beta', '/atom', rss('Beta Feed', ['b1']));
    ext.sites.setRoute('nofeed', '/', html('<h1>No feed here</h1>'));
    ext.sites.setRoute('broken', '/', status(500));
    visits.push([`${o('alpha')}/`, 6], [`${o('alpha')}/post`, 4], [`${o('beta')}/`, 3], [`${o('nofeed')}/`, 4], [`${o('broken')}/`, 2], [`${o('once')}/`, 1]);
    await ext.sw.evaluate(async (list) => {
      for (const [url, n] of list) for (let i = 0; i < n; i++) await chrome.history.addUrl({ url });
    }, visits);
  });
  afterAll(async () => ext.close());

  it('suggests the advertised feeds in rank order and says what it checked', async () => {
    const page = await ext.page(PAGES.options);
    await page.getByRole('button', { name: 'Suggest from my history' }).click();
    const statusLine = page.locator('#sample-feeds [role="status"]');
    await expect.poll(() => statusLine.innerText(), { timeout: 20_000 }).toBe(
      "Found 2 feeds on the 4 sites you visit most. 1 couldn't be reached.",
    );
    const chips = page.locator('#sample-feeds .sample-feeds').first().locator('button');
    expect(await chips.allInnerTexts()).toEqual([
      expect.stringMatching(/^alpha\.e2e\.test:\d+ · visited 10 times$/),
      expect.stringMatching(/^beta\.e2e\.test:\d+ · visited 3 times$/),
    ]);
    await expectA11y(page, 'options');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('adding a suggestion follows it and keeps keyboard focus on the chip', async () => {
    const page = await ext.page(PAGES.options);
    await page.getByRole('button', { name: 'Suggest from my history' }).focus();
    await page.keyboard.press('Enter');
    const first = page.locator('#sample-feeds .sample-feeds').first().locator('button').first();
    await first.waitFor({ timeout: 20_000 });
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.textContent)).toMatch(/^alpha/);
    await page.keyboard.press('Enter');
    await expect.poll(() => storage<string[]>(ext, 'feeds')).toContain(`${ext.sites.origin('alpha')}/feed.xml`);
    await expect.poll(() => first.innerText()).toMatch(/^Following alpha/);
    expect(await page.evaluate(() => document.activeElement?.textContent)).toMatch(/^Following alpha/);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('declining the permission explains itself and changes nothing', async () => {
    const page = await ext.ctx.newPage();
    await page.addInitScript(() => {
      chrome.permissions.request = (async () => false) as typeof chrome.permissions.request;
    });
    await page.goto(`chrome-extension://${ext.id}/${PAGES.options}`);
    await page.getByRole('button', { name: 'Suggest from my history' }).click();
    await expect.poll(() => page.locator('#sample-feeds [role="status"]').innerText()).toContain('need access to your history');
    expectClean(ext);
    await page.close();
  });

  it('offline: says so instead of scanning', async () => {
    const page = await ext.page(PAGES.options);
    await ext.ctx.setOffline(true);
    await page.getByRole('button', { name: 'Suggest from my history' }).click();
    await expect.poll(() => page.locator('#sample-feeds [role="status"]').innerText()).toBe("You're offline. Connect and try again.");
    await ext.ctx.setOffline(false);
    expectClean(ext);
    await page.close();
  });

  it('Add Feed accepts a site and finds the feed it advertises', async () => {
    const page = await ext.page(PAGES.options);
    await page.getByLabel('Feed or site address').fill(`${ext.sites.origin('beta')}/`);
    await page.getByRole('button', { name: 'Add Feed' }).click();
    await expect.poll(() => storage<string[]>(ext, 'feeds')).toContain(`${ext.sites.origin('beta')}/atom`);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('Add Feed on a site with no feed explains what to do', async () => {
    const page = await ext.page(PAGES.options);
    await page.getByLabel('Feed or site address').fill(`${ext.sites.origin('nofeed')}/`);
    await page.getByRole('button', { name: 'Add Feed' }).click();
    await expect.poll(() => page.locator('#add-new-feed [role="status"]').innerText()).toContain("Couldn't find a feed there");
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('chips keep an edge in forced colors and the section reflows at 200% zoom', async () => {
    const page = await ext.page(PAGES.options);
    await page.emulateMedia({ forcedColors: 'active' });
    const style = await page.locator('.sample-feed').first().evaluate((el) => getComputedStyle(el).borderTopStyle);
    expect(style).toBe('solid');
    await page.setViewportSize({ width: 640, height: 900 });
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    expectClean(ext);
    await page.close();
  });
});
```

- [ ] **Step 9: Run everything**

Run: `npm run typecheck && npm test && npm run build && npm run build:e2e && npm run test:e2e`
Expected: all PASS. Then confirm the regular build did not request history up front:
```bash
npm run build && node -e "const m=require('./dist/manifest.json'); console.log(m.permissions.includes('history'), m.optional_permissions)"
```
Expected: `false [ 'history' ]`.

- [ ] **Step 10: Commit**

```bash
git add manifest.config.ts src/pages/options e2e/suggestions.e2e.ts
git commit -m "Suggest feeds from the sites you visit; Add Feed takes a site

History is an optional permission, asked for on click and never stored.
Add Feed accepts a bare site and follows the feed it advertises.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Muted topics: the setting, the matcher, the Settings field

**Files:**
- Modify: `src/shared/types.ts:45-90` (Settings), `src/shared/storage.ts:77-97` (DEFAULT_SETTINGS), `src/shared/llm/triage.ts`, `src/shared/llm/triage.test.ts`, `src/pages/options/NewTabSection.tsx`, `src/pages/options/options.css`
- Create: `e2e/mutedTopics.e2e.ts`

**Interfaces:**
- Produces:
  - `Settings.mutedTopics: string[]` (default `[]`)
  - `normalizeTopics(raw: unknown): string[]`
  - `muteMatcher(topics: unknown): (item: FeedItem) => boolean`
  - `const MUTE_MAX_TOPICS = 100`, `const MUTE_MAX_LENGTH = 80`

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/llm/triage.test.ts` (add `muteMatcher, normalizeTopics` to the `./triage` import):
```ts
describe('normalizeTopics', () => {
  it('trims, collapses spaces, drops blanks and case-insensitive duplicates, keeps order', () => {
    expect(normalizeTopics(['  Sports ', '', 'sports', 'US   election', 'Election'])).toEqual(['Sports', 'US election', 'Election']);
  });

  it('reads a stored string as lines and anything else as empty', () => {
    expect(normalizeTopics('politics\n\ncrypto')).toEqual(['politics', 'crypto']);
    expect(normalizeTopics(undefined)).toEqual([]);
    expect(normalizeTopics(42)).toEqual([]);
    expect(normalizeTopics([1, null, 'ok'])).toEqual(['ok']);
  });

  it('caps the count and the length of each topic', () => {
    expect(normalizeTopics(Array.from({ length: 150 }, (_, i) => `t${i}`))).toHaveLength(100);
    expect(normalizeTopics(['x'.repeat(200)])[0]).toHaveLength(80);
  });
});

describe('muteMatcher', () => {
  const muted = (topics: unknown, title: string, extra: Partial<FeedItem> = {}) => muteMatcher(topics)({ ...item('1', title), ...extra });

  it('matches whole words in any case, in title, snippet or source', () => {
    expect(muted(['election'], 'The Election results')).toBe(true);
    expect(muted(['election'], 'Elections are coming')).toBe(false);
    expect(muted(['ai'], 'He said hello')).toBe(false);
    expect(muted(['ai'], 'An AI model')).toBe(true);
    expect(muted(['sports'], 'Quiet', { snippet: 'Sports roundup' })).toBe(true);
    expect(muted(['The Verge'], 'Anything', { source: 'The Verge' })).toBe(true);
  });

  it('treats regex characters literally and handles non-English letters', () => {
    expect(muted(['C++'], 'Modern C++ tips')).toBe(true);
    expect(muted(['C++'], 'C is fine')).toBe(false);
    expect(muted(['a.b'], 'axb')).toBe(false);
    expect(muted(['(draft)'], 'Paper (draft) notes')).toBe(true);
    expect(muted(['Économie'], "L'économie française")).toBe(true);
    expect(muted(['café'], 'cafés')).toBe(false);
  });

  it('matches a multi-word topic across any whitespace', () => {
    expect(muted(['US election'], 'US\n election night')).toBe(true);
  });

  it('mutes nothing when there are no topics or the stored value is corrupt', () => {
    expect(muted([], 'Anything')).toBe(false);
    expect(muted('', 'Anything')).toBe(false);
    expect(muted({ bad: true }, 'Anything')).toBe(false);
  });

  it('checks 300 items against 100 topics in well under 50 ms', () => {
    const topics = Array.from({ length: 100 }, (_, i) => `topic${i}`);
    const items = Array.from({ length: 300 }, (_, i) => item(String(i), `Headline number ${i} about things`));
    const isMuted = muteMatcher(topics);
    const start = performance.now();
    items.filter(isMuted);
    // ponytail: wall-clock budget with headroom for slow CI runners.
    expect(performance.now() - start).toBeLessThan(50);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/shared/llm/triage.test.ts`
Expected: FAIL, `normalizeTopics is not a function`.

- [ ] **Step 3: Add the setting**

In `src/shared/types.ts`, inside `interface Settings`, after `layaUrl: string;` add:
```ts
  /**
   * Topics hidden from the feed card on the new tab: whole words, any case,
   * matched against title, snippet and source name. Read through
   * normalizeTopics, which also survives a hand-edited value.
   */
  mutedTopics: string[];
```
In `src/shared/storage.ts`, in `DEFAULT_SETTINGS`, after `layaUrl: '',` add:
```ts
  mutedTopics: [],
```

- [ ] **Step 4: Implement the matcher**

Append to `src/shared/llm/triage.ts`:
```ts
export const MUTE_MAX_TOPICS = 100;
export const MUTE_MAX_LENGTH = 80;

/**
 * The muted-topics setting as a clean list. Accepts what might really be in
 * storage: the array this extension writes, a newline string from a
 * hand-edited profile, or junk, which mutes nothing.
 */
export function normalizeTopics(raw: unknown): string[] {
  const list: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('\n') : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const topic = entry.replace(/\s+/g, ' ').trim().slice(0, MUTE_MAX_LENGTH);
    const key = topic.toLocaleLowerCase();
    if (!topic || seen.has(key)) continue;
    seen.add(key);
    out.push(topic);
    if (out.length === MUTE_MAX_TOPICS) break;
  }
  return out;
}

const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/g;

/**
 * One compiled test for the whole list. Word edges are Unicode-aware
 * lookarounds rather than \b, which only knows ASCII letters and would let
 * "café" match inside "cafés".
 */
export function muteMatcher(topics: unknown): (item: FeedItem) => boolean {
  const clean = normalizeTopics(topics);
  if (clean.length === 0) return () => false;
  const alternatives = clean.map((t) => t.replace(REGEX_SYNTAX, '\\$&').replace(/ /g, '\\s+')).join('|');
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`, 'iu');
  return (item) => re.test(item.title) || re.test(item.snippet) || re.test(item.source);
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/shared/llm/triage.test.ts src/shared/storage.test.ts`
Expected: PASS. (`storage.test.ts` derives its live-settings list from `DEFAULT_SETTINGS`, so it now also covers `mutedTopics`.)

- [ ] **Step 6: The Settings field**

In `src/pages/options/NewTabSection.tsx`, add the import:
```ts
import { normalizeTopics } from '../../shared/llm/triage';
```
In `NewTabSection`, after the weather `TextRow`, add:
```tsx
      <MutedTopicsRow value={normalizeTopics(settings.mutedTopics)} />
```
and add this component to the file:
```tsx
/**
 * One topic per line, saved on blur like the other rows here (the new tab
 * re-ranks on every write). The saved list wins if it changes underneath.
 */
function MutedTopicsRow({ value }: { value: string[] }) {
  const joined = value.join('\n');
  const [draft, setDraft] = useState(joined);
  const [syncedTo, setSyncedTo] = useState(joined);
  if (joined !== syncedTo) {
    setSyncedTo(joined);
    setDraft(joined);
  }

  return (
    <div className="setting-row setting-row-stacked">
      <label htmlFor="muted-topics">Hide from your feeds</label>
      <textarea
        id="muted-topics"
        rows={4}
        value={draft}
        placeholder={'One topic per line, like\nsports\nelection'}
        aria-describedby="muted-topics-hint"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = normalizeTopics(draft);
          setDraft(next.join('\n'));
          if (next.join('\n') !== joined) void patchSettings({ mutedTopics: next });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setDraft(joined);
        }}
      />
      <p id="muted-topics-hint" className="hint">
        Whole words, any case. A feed's name works too, to hide everything from it.
      </p>
    </div>
  );
}
```

In `src/pages/options/options.css`, after the `.setting-row label { ... }` rule, add:
```css
.setting-row-stacked {
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-2);
}

.setting-row textarea {
  font: inherit;
  font-size: var(--text-sm);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  color: var(--text-primary);
  resize: vertical;
}
```

- [ ] **Step 7: Browser test for the field**

Create `e2e/mutedTopics.e2e.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGES, expectA11y, expectClean, launch, storage, type Ext } from './harness';

describe('muted topics in Settings', () => {
  let ext: Ext;
  beforeAll(async () => {
    ext = await launch();
  });
  afterAll(async () => ext.close());

  it('saves a cleaned list on blur and Escape restores the saved one', async () => {
    const page = await ext.page(PAGES.options);
    const field = page.getByLabel('Hide from your feeds');
    await field.fill('  Sports \n\nsports\nUS   election');
    await field.blur();
    await expect
      .poll(async () => (await storage<{ mutedTopics?: string[] }>(ext, 'settings'))?.mutedTopics)
      .toEqual(['Sports', 'US election']);
    expect(await field.inputValue()).toBe('Sports\nUS election');

    await field.fill('something unsaved');
    await field.press('Escape');
    expect(await field.inputValue()).toBe('Sports\nUS election');
    await expectA11y(page, 'options');
    expectClean(ext);
    await page.close();
  });
});
```

- [ ] **Step 8: Run everything**

Run: `npm run typecheck && npm test && npm run build && npm run build:e2e && npm run test:e2e`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/shared/types.ts src/shared/storage.ts src/shared/llm/triage.ts src/shared/llm/triage.test.ts src/pages/options/NewTabSection.tsx src/pages/options/options.css e2e/mutedTopics.e2e.ts
git commit -m "Muted topics: a setting and a Unicode-aware whole-word matcher

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The triage card hides muted topics and says how many

**Files:**
- Modify: `src/pages/newtab/TriageCard.tsx`
- Create: `e2e/triage.e2e.ts`

**Interfaces:**
- Consumes: `muteMatcher`, `normalizeTopics` (Task 6); `launch`, `seed`, `expectClean`, `expectA11y`, `PAGES` (Task 2); `feedItem` (Task 2 seed)
- Produces: `.relay-triage-note` paragraph reading `N hidden by muted topics` with an `Edit` button that opens `options#new-tab`; empty state `Nothing new outside your muted topics.`

- [ ] **Step 1: Write the failing browser test**

Create `e2e/triage.e2e.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NETWORK_NOISE, PAGES, expectA11y, expectClean, launch, seed, type Ext } from './harness';
import { feedItem } from './seed';

const OFF = { ollamaUrl: 'http://127.0.0.1:9', layaUrl: '' }; // nothing listens on port 9

describe('triage card and muted topics', () => {
  let ext: Ext;
  beforeAll(async () => {
    ext = await launch();
  });
  afterAll(async () => ext.close());

  const items = [
    feedItem('a', 'Election night results'),
    feedItem('b', 'A new compiler release'),
    feedItem('c', 'Quiet news', { snippet: 'More election coverage' }),
    feedItem('d', 'Rust 2.0 is out'),
    feedItem('e', 'Weather this week', { source: 'Sports Daily' }),
  ];

  it('hides muted items, counts them, and links to the setting', async () => {
    await seed(ext, { cachedItems: items, readItems: [], settings: { ...OFF, mutedTopics: ['election', 'Sports Daily'] } });
    const page = await ext.page(PAGES.newtab);
    const card = page.locator('.edition-feed');
    await expect.poll(() => card.locator('.edition-story-title').allInnerTexts()).toEqual(['A new compiler release', 'Rust 2.0 is out']);
    expect(await card.locator('.relay-triage-note').last().innerText()).toContain('3 hidden by muted topics');
    const opened = ext.ctx.waitForEvent('page');
    await card.getByRole('button', { name: 'Edit muted topics' }).click();
    expect((await opened).url()).toMatch(/options\/index\.html#new-tab$/);
    await expectA11y(page, 'newtab');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('when everything is muted it says so instead of "all caught up"', async () => {
    await seed(ext, { cachedItems: items.slice(0, 1), readItems: [], settings: { ...OFF, mutedTopics: ['election'] } });
    const page = await ext.page(PAGES.newtab);
    await expect.poll(() => page.locator('.edition-feed .relay-empty').innerText()).toBe('Nothing new outside your muted topics.');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('a corrupted mutedTopics (a string) still mutes and never crashes', async () => {
    await seed(ext, { cachedItems: items, readItems: [], settings: { ...OFF, mutedTopics: 'election' } });
    const page = await ext.page(PAGES.newtab);
    await expect.poll(() => page.locator('.edition-feed .edition-story-title').allInnerTexts()).not.toContain('Election night results');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build:e2e && npx vitest run --config vitest.e2e.config.ts e2e/triage.e2e.ts`
Expected: FAIL: the muted titles are still listed, and there is no "hidden by muted topics" note.

- [ ] **Step 3: Filter, count, and say so**

In `src/pages/newtab/TriageCard.tsx`:

Add `muteMatcher` to the `../../shared/llm/triage` import.

Replace
```ts
  const unread = useMemo(() => unreadItems(cachedItems, readItems, CANDIDATES), [cachedItems, readItems]);
```
with
```ts
  // Muted items never reach ranking, so they cost no embeddings either.
  // settings.mutedTopics keeps its identity until Settings writes a new list.
  const isMuted = useMemo(() => muteMatcher(settings.mutedTopics), [settings.mutedTopics]);
  const { unread, mutedCount } = useMemo(() => {
    const read = new Set(readItems);
    const kept = cachedItems.filter((item) => !isMuted(item));
    return {
      unread: unreadItems(kept, readItems, CANDIDATES),
      mutedCount: cachedItems.filter((item) => !read.has(item.id) && isMuted(item)).length,
    };
  }, [cachedItems, readItems, isMuted]);
```

Replace the empty-state line
```tsx
        <p className="relay-empty">All caught up on your feeds.</p>
```
with
```tsx
        <p className="relay-empty">
          {mutedCount > 0 ? 'Nothing new outside your muted topics.' : 'All caught up on your feeds.'}
        </p>
```

After `{note && <p className="relay-triage-note">{note}</p>}` add:
```tsx
      {mutedCount > 0 && (
        <p className="relay-triage-note">
          {mutedCount} hidden by muted topics.{' '}
          <button
            type="button"
            className="edition-link"
            aria-label="Edit muted topics"
            onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/options/index.html#new-tab') })}
          >
            Edit
          </button>
        </p>
      )}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build:e2e && npx vitest run --config vitest.e2e.config.ts e2e/triage.e2e.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full gate and commit**

Run: `npm run typecheck && npm test && npm run build && npm run build:e2e && npm run test:e2e`
Expected: all PASS.
```bash
git add src/pages/newtab/TriageCard.tsx e2e/triage.e2e.ts
git commit -m "Triage card hides muted topics and says how many

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: One story, one row: same-story grouping

**Files:**
- Modify: `src/shared/llm/triage.ts`, `src/shared/llm/triage.test.ts`, `src/background/feeds.ts:117-130,148-191`, `src/background/feeds.test.ts`, `src/shared/messages.ts:20-29`, `src/background/router.ts:28-29`, `src/pages/newtab/TriageCard.tsx`
- Create: `e2e/ollamaMock.ts`; append to `e2e/triage.e2e.ts`

**Interfaces:**
- Consumes: `cosine` from `./vectors`; `Pick`, `rankItems`, `newest`, `rerankPicks` (existing)
- Produces:
  - `Pick` gains `also: FeedItem[]`
  - `const SAME_STORY_MIN = 0.85`
  - `clusterPicks(picks: readonly Pick[], vectorOf: (item: FeedItem) => ArrayLike<number> | undefined, min?: number): Pick[]`
  - `alsoLabel(pick: Pick): string`
  - `appendRead(readItems: readonly string[], ids: readonly string[], cap: number): string[]` and `markItemsRead(ids: readonly string[]): Promise<void>` in `background/feeds.ts`
  - `OPEN_ARTICLE` message gains `alsoReadIds?: string[]`
  - `startOllamaMock(clusters: Record<string, number[]>): Promise<{ url: string; close(): Promise<void> }>` in `e2e/ollamaMock.ts`

- [ ] **Step 1: Write the failing unit tests**

Append to `src/shared/llm/triage.test.ts` (add `alsoLabel, clusterPicks, type Pick` to the `./triage` import):
```ts
describe('clusterPicks', () => {
  const pick = (id: string, source = 'Feed'): Pick => ({ item: { ...item(id, `t${id}`), source }, because: null, also: [] });
  const vectors: Record<string, number[]> = { a: [1, 0, 0], b: [0.99, 0.05, 0], c: [0, 1, 0], d: [0.98, 0.1, 0] };
  const vectorOf = (i: FeedItem) => vectors[i.id];

  it('folds near-duplicates into the first, highest-ranked pick, keeping rank order', () => {
    const out = clusterPicks([pick('a'), pick('c'), pick('b'), pick('d')], vectorOf);
    expect(out.map((p) => [p.item.id, p.also.map((x) => x.id)])).toEqual([
      ['a', ['b', 'd']],
      ['c', []],
    ]);
  });

  it('leaves picks without a vector alone and respects the threshold', () => {
    expect(clusterPicks([pick('a'), pick('x'), pick('b')], vectorOf).map((p) => p.item.id)).toEqual(['a', 'x']);
    expect(clusterPicks([pick('a'), pick('b')], vectorOf, 0.9999).map((p) => p.item.id)).toEqual(['a', 'b']);
  });

  it('is empty for no picks', () => {
    expect(clusterPicks([], vectorOf)).toEqual([]);
  });
});

describe('alsoLabel', () => {
  const withAlso = (sources: string[]): Pick => ({
    item: { ...item('lead', 'Lead'), source: 'Ars' },
    because: null,
    also: sources.map((s, i) => ({ ...item(`x${i}`, 'x'), source: s })),
  });

  it('counts other sources, and says "similar" when the copies share the lead source', () => {
    expect(alsoLabel(withAlso([]))).toBe('');
    expect(alsoLabel(withAlso(['Verge']))).toBe('+1 source');
    expect(alsoLabel(withAlso(['Verge', 'Wired', 'Verge']))).toBe('+2 sources');
    expect(alsoLabel(withAlso(['Ars', 'Ars']))).toBe('+2 similar');
  });
});
```

Update the existing expectations in `triage.test.ts` that build or compare `Pick` objects: every literal `{ item, because }` becomes `{ item, because, also: [] }`. Run `grep -n "because" src/shared/llm/triage.test.ts` to find them.

Append to `src/background/feeds.test.ts` (add `appendRead` to its `./feeds` import):
```ts
describe('appendRead', () => {
  it('appends new ids once, in order, and evicts the oldest past the cap', () => {
    expect(appendRead(['a', 'b'], ['b', 'c', 'd', 'c'], 3)).toEqual(['b', 'c', 'd']);
    expect(appendRead([], [], 3)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/shared/llm/triage.test.ts src/background/feeds.test.ts`
Expected: FAIL, `clusterPicks is not a function`, `appendRead is not a function`.

- [ ] **Step 3: Implement grouping**

In `src/shared/llm/triage.ts`:

Change the `Pick` interface to:
```ts
export interface Pick {
  item: FeedItem;
  /** The profile entry this item is close to; null when nothing is close */
  because: string | null;
  /** Other items telling the same story, folded into this row */
  also: FeedItem[];
}
```
In `rankItems`, change the final `.map(...)` to:
```ts
    .map(({ item, because, score }) => ({ item, because: score >= minReason ? because : null, also: [] }));
```
In `newest`, change the body to:
```ts
  return items.slice(0, k).map((item) => ({ item, because: null, also: [] }));
```
Append:
```ts
/**
 * Above this cosine two feed items are the same story told by different
 * sources. ponytail: uncalibrated for nomic-embed-text; measure on real
 * duplicates if it groups too much or too little.
 */
export const SAME_STORY_MIN = 0.85;

/**
 * Fold each pick into the first earlier pick telling the same story, so the
 * card's five rows are five stories. Rank order is kept; a pick without a
 * vector is never folded, since nothing can be said about it.
 */
export function clusterPicks(
  picks: readonly Pick[],
  vectorOf: (item: FeedItem) => ArrayLike<number> | undefined,
  min = SAME_STORY_MIN,
): Pick[] {
  const leaders: { pick: Pick; vector: ArrayLike<number> | undefined }[] = [];
  for (const pick of picks) {
    const vector = vectorOf(pick.item);
    const home = vector ? leaders.find((l) => l.vector && cosine(vector, l.vector) >= min) : undefined;
    if (home) home.pick = { ...home.pick, also: [...home.pick.also, pick.item, ...pick.also] };
    else leaders.push({ pick, vector });
  }
  return leaders.map((l) => l.pick);
}

/** "+2 sources" for the row; "+N similar" when the copies share the lead's source. */
export function alsoLabel(pick: Pick): string {
  if (pick.also.length === 0) return '';
  const others = new Set(pick.also.map((a) => a.source).filter((s) => s !== pick.item.source)).size;
  if (others === 0) return `+${pick.also.length} similar`;
  return `+${others} ${others === 1 ? 'source' : 'sources'}`;
}
```

- [ ] **Step 4: Mark the folded items read when the row opens**

In `src/background/feeds.ts`, replace `markItemRead` with:
```ts
/** Ids appended once each, in order; the oldest fall off past `cap`. */
export function appendRead(readItems: readonly string[], ids: readonly string[], cap: number): string[] {
  const next = [...readItems];
  const have = new Set(next);
  for (const id of ids) {
    if (have.has(id)) continue;
    have.add(id);
    next.push(id);
  }
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export async function markItemsRead(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const { readItems } = await getLocal('readItems');
  const next = appendRead(readItems, ids, MAX_READ_ITEMS);
  if (next.length !== readItems.length || next.some((id, i) => id !== readItems[i])) await setLocal({ readItems: next });
}

export async function markItemRead(itemId: string): Promise<void> {
  await markItemsRead([itemId]);
}
```
Change `openArticle`'s signature and first lines to:
```ts
export async function openArticle(
  url: string,
  feedItemId: string | null,
  resume = false,
  readerView = true,
  original = false,
  alsoReadIds: readonly string[] = [],
): Promise<{ ok: boolean }> {
  // The row it was opened from may stand for the same story from other feeds;
  // reading one reads the story.
  await markItemsRead([...(feedItemId ? [feedItemId] : []), ...alsoReadIds]);
```
and delete the old `if (feedItemId) { await markItemRead(feedItemId); }` block.

In `src/shared/messages.ts`, inside the `OPEN_ARTICLE` variant, after `original?: boolean;` add:
```ts
      /** Same-story items folded into the opened row; marked read with it */
      alsoReadIds?: string[];
```
In `src/background/router.ts`, change the `OPEN_ARTICLE` case to:
```ts
    case 'OPEN_ARTICLE':
      return openArticle(msg.url, msg.feedItemId, msg.resume ?? false, msg.readerView ?? true, msg.original ?? false, msg.alsoReadIds ?? []);
```

- [ ] **Step 5: Run the unit tests**

Run: `npx vitest run src/shared/llm/triage.test.ts src/background/feeds.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Group in the card**

In `src/pages/newtab/TriageCard.tsx`:

Add `alsoLabel, clusterPicks` to the `../../shared/llm/triage` import.

Replace
```ts
        const shortlist = rankItems(unread, (i) => vectorOf(itemKey(i.id)), profile, (p) => vectorOf(profileKey(p.id)), RERANK_POOL);
        return { picks: await rerankPicks(settings.layaUrl, shortlist, profile, SHOWN), note: '' };
```
with
```ts
        const itemVector = (i: FeedItem) => vectorOf(itemKey(i.id));
        const shortlist = rankItems(unread, itemVector, profile, (p) => vectorOf(profileKey(p.id)), RERANK_POOL);
        // Group before Laya, so it reranks stories rather than copies of one.
        const stories = clusterPicks(shortlist, itemVector);
        return { picks: await rerankPicks(settings.layaUrl, stories, profile, SHOWN), note: '' };
```
and add `import type { FeedItem } from '../../shared/types';`.

In the row, replace `{picks.map(({ item, because }) => (` with `{picks.map((pick) => { const { item, because, also } = pick; return (`, close it with `); })}`, and change:
- the `sendMessage` call to:
```ts
                  void sendMessage({
                    type: 'OPEN_ARTICLE',
                    url: item.link,
                    feedItemId: item.id,
                    readerView: false,
                    original: true,
                    alsoReadIds: also.map((a) => a.id),
                  });
```
- the meta line to:
```tsx
                <span className="edition-story-meta">
                  {item.source}
                  {also.length > 0 && ` ${alsoLabel(pick)}`}
                </span>
```

- [ ] **Step 7: An Ollama stand-in for the browser suite**

Create `e2e/ollamaMock.ts`:
```ts
import { createServer } from 'node:http';

/**
 * Just enough of Ollama for the triage card: /api/tags and /api/show for the
 * health check, /api/embed for vectors. Text containing a key of `clusters`
 * gets that vector; everything else gets its own, unrelated one.
 */
export async function startOllamaMock(clusters: Record<string, number[]>): Promise<{ url: string; close(): Promise<void> }> {
  const DIM = 8;
  const own = (text: string) => {
    const v = Array.from({ length: DIM }, () => 0);
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIM] = 1;
    v[(h >>> 8) % DIM] += 0.5;
    return v;
  };
  const vectorFor = (text: string) => {
    const key = Object.keys(clusters).find((k) => text.toLowerCase().includes(k));
    return key ? clusters[key] : own(text);
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'nomic-embed-text' }] }));
      if (req.url === '/api/show') return res.end('{}');
      if (req.url === '/api/embed') {
        const input = (JSON.parse(body) as { input: string[] }).input;
        return res.end(JSON.stringify({ embeddings: input.map(vectorFor) }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}
```

- [ ] **Step 8: Browser test for grouping**

Append inside the `describe` in `e2e/triage.e2e.ts` (add imports `startOllamaMock` from `./ollamaMock`, `article` from `./seed`, `storage` from `./harness`):
```ts
  it('one story from three feeds is one row, and opening it reads all three', async () => {
    // One vector per story, named outright: hashed fallbacks could collide and
    // merge two unrelated test items.
    const axis = (i: number) => Array.from({ length: 8 }, (_, j) => (j === i ? 1 : 0));
    const ollama = await startOllamaMock({ fusion: axis(0), compiler: axis(1), rust: axis(2) });
    const finished = article('http://read.e2e.test/x', 'Notes on fusion energy', { completedAt: Date.now() - 3_600_000, maxPercent: 100 });
    const story = [
      feedItem('f1', 'Fusion breakthrough at NIF', { source: 'Ars' }),
      feedItem('f2', 'NIF fusion milestone', { source: 'Verge' }),
      feedItem('f3', 'Fusion record announced', { source: 'Wired' }),
    ];
    await seed(ext, {
      cachedItems: [...story, feedItem('o1', 'A compiler release'), feedItem('o2', 'Rust 2.0 is out')],
      readItems: [],
      readingProgress: { [finished.url]: finished },
      settings: { ollamaUrl: ollama.url, ollamaEmbedModel: 'nomic-embed-text', layaUrl: '', mutedTopics: [] },
    });
    const page = await ext.page(PAGES.newtab);
    const rows = page.locator('.edition-feed .edition-story');
    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBe(3);
    const fusionRow = rows.filter({ hasText: 'Fusion' });
    expect(await fusionRow.locator('.edition-story-meta').innerText()).toMatch(/\+2 sources$/);

    const opened = ext.ctx.waitForEvent('page');
    await fusionRow.click();
    await (await opened).close();
    await expect.poll(() => storage<string[]>(ext, 'readItems')).toEqual(expect.arrayContaining(['f1', 'f2', 'f3']));
    expectClean(ext, NETWORK_NOISE);
    await page.close();
    await ollama.close();
  });

  it('Ollama down: newest first, nothing grouped, and the card says why', async () => {
    await seed(ext, {
      cachedItems: [feedItem('f1', 'Fusion one'), feedItem('f2', 'Fusion two')],
      readItems: [],
      readingProgress: { x: article('http://read.e2e.test/y', 'Read', { completedAt: Date.now(), maxPercent: 100 }) },
      settings: { ...OFF, mutedTopics: [] },
    });
    const page = await ext.page(PAGES.newtab);
    await expect.poll(() => page.locator('.edition-feed .edition-story').count()).toBe(2);
    expect(await page.locator('.edition-feed .relay-triage-note').first().innerText()).toContain('local AI is off');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
```

- [ ] **Step 9: Run everything**

Run: `npm run typecheck && npm test && npm run build && npm run build:e2e && npm run test:e2e`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add src/shared/llm/triage.ts src/shared/llm/triage.test.ts src/background/feeds.ts src/background/feeds.test.ts src/shared/messages.ts src/background/router.ts src/pages/newtab/TriageCard.tsx e2e/ollamaMock.ts e2e/triage.e2e.ts
git commit -m "One story, one row: group same-story feed items before Laya reranks

Opening the row marks every folded item read so the copies do not
resurface on the next tab.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Load suite and final verification

**Files:**
- Create: `e2e/load.e2e.ts`

**Interfaces:**
- Consumes: `launch`, `seed`, `expectClean`, `PAGES` (Task 2); `article`, `feedItem`, `paper`, `deck` (Task 2 seed)

- [ ] **Step 1: Write the load tests**

Create `e2e/load.e2e.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { NETWORK_NOISE, PAGES, expectClean, launch, seed, type Ext } from './harness';
import { article, deck, feedItem, paper } from './seed';

/**
 * A heavy profile at every cap the extension has: 300 cached feed items
 * (MAX_CACHED_ITEMS), 500 read ids, 400 unfinished articles, 200 papers,
 * 150 feeds, 100 muted topics. Budgets are wall-clock with headroom for CI.
 * ponytail: tighten once a few CI runs show the real numbers.
 */
const BUDGET = { firstStoryMs: 2500, settingsMs: 2500, longestTaskMs: 600, twentyStepsMs: 2000 };

async function longestTask(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let max = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) max = Math.max(max, entry.duration);
        }).observe({ type: 'longtask', buffered: true });
        setTimeout(() => resolve(max), 300);
      }),
  );
}

describe('load: a heavy profile stays fast', () => {
  let ext: Ext;
  beforeAll(async () => {
    ext = await launch();
    const progress = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => {
        const url = `http://article.e2e.test/p${i}`;
        return [url, article(url, `Unfinished article ${i}`, { updatedAt: Date.now() - i * 60_000 })];
      }),
    );
    await seed(ext, {
      readingProgress: progress,
      cachedItems: Array.from({ length: 300 }, (_, i) => feedItem(`i${i}`, `Feed headline ${i}`)),
      readItems: Array.from({ length: 500 }, (_, i) => `old${i}`),
      decks: [deck],
      papers: Array.from({ length: 200 }, (_, i) => paper(String(i), `Paper ${i}`)),
      feeds: Array.from({ length: 150 }, (_, i) => `http://feed${i}.e2e.test/rss`),
      settings: { ollamaUrl: 'http://127.0.0.1:9', layaUrl: '', mutedTopics: Array.from({ length: 100 }, (_, i) => `topic${i}`) },
    });
  });
  afterAll(async () => ext.close());

  it('new tab shows its first story within budget, with no long task over budget', async () => {
    const page = await ext.ctx.newPage();
    const start = Date.now();
    await page.goto(`chrome-extension://${ext.id}/${PAGES.newtab}`);
    await page.locator('[data-story]').first().waitFor();
    expect(Date.now() - start).toBeLessThan(BUDGET.firstStoryMs);
    expect(await longestTask(page)).toBeLessThan(BUDGET.longestTaskMs);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('J walks twenty stories within budget', async () => {
    const page = await ext.page(PAGES.newtab);
    await page.locator('[data-story]').first().waitFor();
    const start = Date.now();
    for (let i = 0; i < 20; i++) await page.keyboard.press('j');
    expect(Date.now() - start).toBeLessThan(BUDGET.twentyStepsMs);
    expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-story'))).toBe(true);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('Settings with 150 feeds and 100 muted topics is usable within budget', async () => {
    const page = await ext.ctx.newPage();
    const start = Date.now();
    await page.goto(`chrome-extension://${ext.id}/${PAGES.options}`);
    await page.getByRole('button', { name: 'Suggest from my history' }).waitFor();
    expect(Date.now() - start).toBeLessThan(BUDGET.settingsMs);
    expect((await page.getByLabel('Hide from your feeds').inputValue()).split('\n')).toHaveLength(100);
    expect(await longestTask(page)).toBeLessThan(BUDGET.longestTaskMs);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm run build:e2e && npx vitest run --config vitest.e2e.config.ts e2e/load.e2e.ts`
Expected: PASS. If a budget fails, find the slow path (Performance panel trace on the same seeded profile) before touching the number. Raise a budget only with a `ponytail:` note saying what was measured.

- [ ] **Step 3: Full gate**

Run: `npm run typecheck && npm test && npm run build && npm run build:e2e && npm run test:e2e`
Expected: all PASS.

- [ ] **Step 4: Drive it by hand with /verify**

Invoke the project's `/verify` skill and check, with screenshots in light and dark:
- Options: "Suggest from my history" against a real profile shows Chrome's permission prompt (regular build, not E2E), and declining leaves the explanatory line.
- `chrome://extensions` → Reader → Details → Permissions: history can be switched off; the next click asks again.
- New tab: a muted topic disappears from the card within a second of leaving the Settings field.
- Ctrl/Cmd+F on Options finds text in the suggestions; Chrome's page zoom at 200% keeps Options readable.

- [ ] **Step 5: Commit**

```bash
git add e2e/load.e2e.ts
git commit -m "Load suite: a profile at every cap stays within budget

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
