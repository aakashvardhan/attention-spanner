import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NETWORK_NOISE, PAGES, expectA11y, expectClean, horizontalOverflow, launch, seed, shot, type Ext } from './harness';
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
      // Nothing listens on port 9: every run sees "Ollama is off", whether or
      // not the machine running the suite has a real Ollama on 11434.
      settings: { ollamaUrl: 'http://127.0.0.1:9' },
      readingProgress: {
        [leadUrl]: article(leadUrl, 'The lead story', { updatedAt: Date.now() - 60_000 }),
        [`${leadUrl}2`]: article(`${leadUrl}2`, 'The second story'),
      },
      decks: [deck],
      papers: [paper('1', 'A paper in progress')],
    });
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

  it('new tab: the newest Continue row is first, J/K walk the rows, Enter opens it', async () => {
    const page = await ext.page(PAGES.newtab);
    const stories = page.locator('[data-story]');
    await expect.poll(() => stories.count()).toBeGreaterThanOrEqual(2);
    expect(await page.locator('section[aria-label="Continue"] [data-story]').first().innerText()).toContain('The lead story');
    expect(await stories.first().innerText()).toContain('The lead story');

    await page.keyboard.press('j');
    expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-story'))).toBe(true);
    await page.keyboard.press('k');

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Enter');
    await page.waitForURL(leadUrl);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('new tab: ⌘/Ctrl-click opens a story in a new tab and leaves this one', async () => {
    const page = await ext.page(PAGES.newtab);
    const opened = ext.ctx.waitForEvent('page');
    await page.locator('[data-story]').first().click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    const tab = await opened;
    await tab.waitForLoadState();
    expect(tab.url()).toBe(leadUrl);
    expect(page.url()).toContain('newtab');
    expectClean(ext, NETWORK_NOISE);
    await tab.close();
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

  it('blocked page: during focus it names the site and nothing moves on its own', async () => {
    await seed(ext, { focusSession: { phase: 'focus', round: 1, phaseStartedAt: Date.now(), phaseEndsAt: Date.now() + 20 * 60_000, startedAt: Date.now(), focusMinutes: 25 } });
    const page = await ext.page(PAGES.blocked);
    await expect.poll(() => page.locator('h1').innerText()).toBe('example.com is blocked');
    expect(await page.locator('svg.blocked-robot').count()).toBe(0);
    await seed(ext, { focusSession: null });
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('blocked page quotes the clock-in intention', async () => {
    await seed(ext, { focusSession: { phase: 'focus', round: 1, phaseStartedAt: Date.now(), phaseEndsAt: Date.now() + 20 * 60_000, startedAt: Date.now(), focusMinutes: 25, intention: 'write ch. 3' } });
    const page = await ext.page('src/pages/blocked/index.html#https://x.com/');
    await expect.poll(() => page.locator('.blocked-intention').innerText()).toBe('You said: write ch. 3');
    await seed(ext, { focusSession: null });
    await page.close();
  });

  it('blocked page: outside a focus session it offers the way back', async () => {
    const page = await ext.page(PAGES.blocked);
    await expect.poll(() => page.locator('h1').innerText()).toBe('Focus session over');
    expect(await page.locator('a.blocked-continue').getAttribute('href')).toBe('https://example.com/');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
});
