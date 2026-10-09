import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NETWORK_NOISE, PAGES, expectA11y, expectClean, horizontalOverflow, launch, seed, storage, type Ext } from './harness';
import { html, rss, status } from './sites';

describe('suggested feeds', () => {
  let ext: Ext;
  const visits: [string, number][] = [];

  beforeAll(async () => {
    ext = await launch();
    await seed(ext, { settings: { ollamaUrl: 'http://127.0.0.1:9' } });
    const o = (h: string) => ext.sites.origin(h);
    ext.sites.setRoute('alpha', '/', html('<h1>Alpha</h1>', '<link rel="alternate" type="application/rss+xml" href="/feed.xml">'));
    ext.sites.setRoute('alpha', '/feed.xml', rss('Alpha Feed', ['a1', 'a2']));
    ext.sites.setRoute('beta', '/', html('<h1>Beta</h1>', '<link rel="alternate" type="application/atom+xml" href="/atom">'));
    ext.sites.setRoute('beta', '/atom', rss('Beta Feed', ['b1']));
    ext.sites.setRoute('nofeed', '/', html('<h1>No feed here</h1>'));
    ext.sites.setRoute('broken', '/', status(500));
    // Advertises a feed that has no items, so validation refuses it on add.
    ext.sites.setRoute('empty', '/', html('<h1>Empty</h1>', '<link rel="alternate" type="application/rss+xml" href="/rss">'));
    ext.sites.setRoute('empty', '/rss', rss('Empty Feed', []));
    // Slow enough that a second click lands while the scan is still running.
    ext.sites.setRoute('slow', '/', (req, res) => void setTimeout(() => html('<h1>Slow</h1>')(req, res), 1500));
    visits.push([`${o('alpha')}/`, 6], [`${o('alpha')}/post`, 4], [`${o('beta')}/`, 3], [`${o('nofeed')}/`, 4], [`${o('broken')}/`, 2], [`${o('empty')}/`, 2], [`${o('slow')}/`, 2], [`${o('once')}/`, 1]);
    await ext.sw.evaluate(async (list) => {
      for (const [url, n] of list) for (let i = 0; i < n; i++) await chrome.history.addUrl({ url });
    }, visits);
  });
  afterAll(async () => ext.close());
  beforeEach(() => void ext.errors.splice(0));

  it('suggests the advertised feeds in rank order and says what it checked', async () => {
    const page = await ext.page(PAGES.options);
    await page.getByRole('button', { name: 'Suggest from my history' }).click();
    const statusLine = page.locator('#sample-feeds [role="status"]');
    await expect.poll(() => statusLine.innerText(), { timeout: 20_000 }).toBe(
      "Found 3 feeds on the 6 sites you visit most. 1 couldn't be reached.",
    );
    const chips = page.getByRole('group', { name: 'From your history' }).getByRole('button');
    expect(await chips.allInnerTexts()).toEqual([
      expect.stringMatching(/^alpha\.e2e\.test:\d+ · visited 10 times$/),
      expect.stringMatching(/^beta\.e2e\.test:\d+ · visited 3 times$/),
      expect.stringMatching(/^empty\.e2e\.test:\d+ · visited 2 times$/),
    ]);
    await expectA11y(page, 'options');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('clicking again while it scans does not cancel the scan', async () => {
    const page = await ext.page(PAGES.options);
    const suggest = page.getByRole('button', { name: 'Suggest from my history' });
    await suggest.scrollIntoViewIfNeeded();
    const box = (await suggest.boundingBox())!;
    // Near the left edge: inside the narrower Cancel that takes the slot mid-scan.
    const at = [box.x + 16, box.y + box.height / 2] as const;
    await page.mouse.click(...at);
    await expect.poll(() => page.locator('#sample-feeds [role="status"]').innerText()).toBe('Checking the sites you visit most...');
    // The second half of a double-click lands on the same spot, mid-scan.
    await page.mouse.click(...at);
    await expect
      .poll(() => page.locator('#sample-feeds [role="status"]').innerText(), { timeout: 20_000 })
      .toMatch(/^Found 3 feeds/);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('a chip stays readable while hovered', async () => {
    const page = await ext.page(PAGES.options);
    await page.locator('.sample-feed').first().hover();
    await expectA11y(page, 'options');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.locator('.sample-feed').first().hover();
    await expectA11y(page, 'options');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('a suggestion that fails to add says so next to the chips', async () => {
    const page = await ext.page(PAGES.options);
    await page.getByRole('button', { name: 'Suggest from my history' }).click();
    const chip = page.getByRole('group', { name: 'From your history' }).getByRole('button', { name: /^empty/ });
    await chip.click({ timeout: 20_000 });
    await expect
      .poll(() => page.locator('#sample-feeds [role="status"]').innerText(), { timeout: 10_000 })
      .toContain("Couldn't find a feed there");
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('adding a suggestion follows it and keeps keyboard focus on the chip', async () => {
    const page = await ext.page(PAGES.options);
    await page.getByRole('button', { name: 'Suggest from my history' }).focus();
    await page.keyboard.press('Enter');
    const first = page.getByRole('group', { name: 'From your history' }).getByRole('button').first();
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
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('offline: says so instead of scanning', async () => {
    const page = await ext.page(PAGES.options);
    await ext.ctx.setOffline(true);
    await page.getByRole('button', { name: 'Suggest from my history' }).click();
    await expect.poll(() => page.locator('#sample-feeds [role="status"]').innerText()).toBe("You're offline. Connect and try again.");
    await ext.ctx.setOffline(false);
    expectClean(ext, NETWORK_NOISE);
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
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
});
