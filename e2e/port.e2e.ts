import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NETWORK_NOISE, PAGES, expectA11y, expectClean, launch, type Ext } from './harness';

/**
 * The Rust port, phase by phase. Runs only against the Rust build
 * (DIST=rust/ext/dist/chromium npm run test:e2e); the rest of the suite is the
 * port's finish line and is pointed at it page by page as each lands.
 */
describe.skipIf(!process.env.DIST?.includes('rust'))('rust port: phase 0 skeleton', () => {
  let ext: Ext;
  beforeAll(async () => {
    ext = await launch();
  });
  afterAll(async () => ext?.close());

  it('the worker boots from wasm', async () => {
    expect(await ext.sw.evaluate(() => chrome.runtime.getManifest().name)).toBe('Reader');
    const permissions = await ext.sw.evaluate(() => chrome.runtime.getManifest().permissions);
    expect(permissions).toEqual(['storage', 'alarms', 'declarativeNetRequest', 'identity']);
  });

  it('the new tab override mounts a Leptos page with the shared stylesheets, accessibly', async () => {
    const page = await ext.page(PAGES.newtab);
    await expect.poll(() => page.locator('main.edition .hint').innerText()).toBe('Reader, in Rust.');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
    expect(await page.title()).toBe('New Tab');
    // theme.css loaded: the walnut ground, not the browser's white
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(28, 20, 16)');
    await expectA11y(page, 'newtab');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
});
