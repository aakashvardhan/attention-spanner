import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NETWORK_NOISE, PAGES, storage, expectA11y, expectClean, horizontalOverflow, launch, seed, shot, type Ext } from './harness';
import { folder, paper } from './seed';

describe('smoke: every page renders, is accessible, and works with Chromium built-ins', () => {
  let ext: Ext;

  beforeAll(async () => {
    ext = await launch();
    await seed(ext, { folders: [folder], papers: [paper('1', 'A paper in progress')] });
  });
  afterAll(async () => ext.close());
  // Errors from a test that failed before its own expectClean stay with it.
  beforeEach(() => void ext.errors.splice(0));

  for (const [name, path] of Object.entries(PAGES)) {
    it(`${name}: no errors, declared language, no new a11y violations (light and dark)`, async () => {
      const page = await ext.page(path);
      expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
      await expectA11y(page, name);
      await shot(page, `smoke-${name}-light`);
      await page.emulateMedia({ colorScheme: 'dark' });
      await expectA11y(page, name);
      await shot(page, `smoke-${name}-dark`);
      expectClean(ext, NETWORK_NOISE);
      await page.close();
    });

    it(`${name}: reflows at 200% zoom without sideways scrolling`, async () => {
      const page = await ext.page(path);
      await page.setViewportSize({ width: 640, height: 900 });
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      expectClean(ext, NETWORK_NOISE);
      await page.close();
    });

    it(`${name}: renders under forced colors and reduced motion`, async () => {
      const page = await ext.page(path);
      await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => document.body.innerText.length)).toBeGreaterThan(0);
      expectClean(ext, NETWORK_NOISE);
      await page.close();
    });
  }

  it('new tab: the index along the foot holds exactly Papers and Settings', async () => {
    const page = await ext.page(PAGES.newtab);
    await expect
      .poll(() => page.locator('.edition-index .edition-link').allInnerTexts())
      .toEqual(['Papers', 'Settings']);
    expect(await page.locator('.edition-index a, .edition-index button').count()).toBe(2);
    await page.close();
  });

  it('options: no viewfinder frame, no world view', async () => {
    const page = await ext.page(PAGES.options);
    expect(await page.locator('.brackets').count()).toBe(0);
    expect(await page.getByLabel('New tab', { exact: true }).count()).toBe(0);
    expect(await page.getByLabel('Camera', { exact: true }).count()).toBe(0);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('options: the Claude key persists on blur and Escape restores the saved one', async () => {
    const page = await ext.page(PAGES.options);
    const field = page.getByLabel('Anthropic API key');
    await field.fill('sk-ant-e2e');
    await field.blur();
    await expect.poll(async () => (await storage<{ claudeKey?: string }>(ext, 'settings'))?.claudeKey).toBe('sk-ant-e2e');
    await field.fill('typo');
    await field.press('Escape');
    expect(await field.inputValue()).toBe('sk-ant-e2e');
    await page.close();
  });

  it('options: nothing of the cut features is left', async () => {
    const page = await ext.page(PAGES.options);
    for (const gone of ['Add New Feed', 'Your Feeds', 'Refresh Interval', 'Local AI', 'Continue', 'Focus length:', 'Semantic Scholar'])
      expect(await page.getByText(gone, { exact: true }).count(), gone).toBe(0);
    await page.close();
  });

  it('blocked page: while a paper is open it names the site and the paper, and offers the way back', async () => {
    await seed(ext, { focusSession: { startedAt: Date.now(), tabIds: [999999], title: 'Attention Is All You Need' } });
    const page = await ext.page(PAGES.blocked);
    await expect.poll(() => page.locator('h1').innerText()).toBe('example.com is blocked while you read');
    expect(await page.locator('.blocked-intention').innerText()).toBe("You're reading: Attention Is All You Need");
    expect(await page.getByRole('button', { name: 'Back to your paper' }).count()).toBe(1);
    await seed(ext, { focusSession: null });
    await expect.poll(() => page.locator('h1').innerText()).toBe('Reading session over');
    expect(await page.locator('a.blocked-continue').getAttribute('href')).toBe('https://example.com/');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
});
