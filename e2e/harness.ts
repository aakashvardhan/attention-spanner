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
  // Emptied first, so a failing assertion cannot leak into the next test.
  const unexpected = ext.errors.splice(0).filter((e) => !allow.some((re) => re.test(e)));
  expect(unexpected).toEqual([]);
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
 * Wait out running transitions and animations (capped at 2s). A theme switch
 * eases colours over a few hundred ms; contrast measured mid-ease is neither
 * theme's real contrast.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // Two frames first: a media change starts its transitions at the next
    // style recalc, so asking for animations right away finds none.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await Promise.race([
      Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  });
}

/**
 * No violation outside the baseline, and no baselined violation that has gone
 * away (so the baseline only ever shrinks).
 */
export async function expectA11y(page: Page, pageName: string): Promise<void> {
  await settle(page);
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
