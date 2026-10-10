import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NETWORK_NOISE, PAGES, expectA11y, expectClean, launch, seed, storage, type Ext } from './harness';
import { html } from './sites';
import { article, feedItem } from './seed';

const OFF = { ollamaUrl: 'http://127.0.0.1:9', layaUrl: '', mutedTopics: [] };

describe('the new tab as a world', () => {
  let ext: Ext;
  const urls: string[] = [];

  beforeAll(async () => {
    ext = await launch();
    for (const name of ['one', 'two', 'three']) {
      const url = `${ext.sites.origin('article')}/${name}`;
      ext.sites.setRoute('article', `/${name}`, html(`<h1>${name}</h1>`));
      urls.push(url);
    }
  });
  afterAll(async () => ext.close());
  beforeEach(async () => {
    ext.errors.splice(0);
    await seed(ext, {
      settings: { ...OFF, worldView: 'world', comfort: 'recommended', ambientMotion: true },
      readingProgress: {
        [urls[0]]: article(urls[0], 'Lead story', { updatedAt: Date.now() - 60_000, activeSeconds: 600, maxPercent: 40 }),
        [urls[1]]: article(urls[1], 'Second story', { updatedAt: Date.now() - 86_400_000 }),
        [urls[2]]: article(urls[2], 'Third story', { updatedAt: Date.now() - 5 * 86_400_000 }),
      },
      cachedItems: [feedItem('a', 'Feed one'), feedItem('b', 'Feed two')],
      readItems: [],
      focusSession: null,
    });
  });

  it('renders the frame, the path and the lane, with the lead locked and forecast at your pace', async () => {
    const page = await ext.page(PAGES.newtab);
    await expect.poll(() => page.locator('main.world .world-place[data-place]').count()).toBe(5);
    expect(await page.locator('.world-place[data-locked]').innerText()).toContain('Lead story');
    expect(await page.locator('.world-place[data-locked]').innerText()).toContain('≈15 min at your pace');
    expect(await page.locator('.edition-masthead h1').count()).toBe(1);
    await expectA11y(page, 'newtab');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('lists the same stories in the same order as the flat view (parity)', async () => {
    const page = await ext.page(PAGES.newtab);
    await page.locator('[data-story]').first().waitFor();
    const world = await page.locator('[data-story]').allInnerTexts();
    await page.keyboard.press('v');
    await expect.poll(() => page.locator('main.edition').count()).toBe(1);
    const title = (t: string) => t.split('\n').find((l) => /story|Feed/.test(l));
    // The flat feed card ranks again on mount, so its rows arrive a beat later.
    await expect.poll(async () => (await page.locator('[data-story]').allInnerTexts()).map(title)).toEqual(world.map(title));
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('J moves the camera and the lock, with the vignette only while it moves', async () => {
    const page = await ext.page(PAGES.newtab);
    const scene = page.locator('.world-scene');
    const before = await scene.evaluate((el) => (el as HTMLElement).style.transform);
    await page.keyboard.press('j');
    await expect.poll(() => scene.evaluate((el) => (el as HTMLElement).style.transform)).not.toBe(before);
    expect(await page.locator('.world-place[data-locked]').innerText()).toContain('Second story');
    expect(await page.locator('main.world[data-moving]').count()).toBe(1);
    await expect.poll(() => page.locator('main.world[data-moving]').count(), { timeout: 3000 }).toBe(0);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('comfortable cuts: no camera transition', async () => {
    await seed(ext, { settings: { ...OFF, worldView: 'world', comfort: 'comfortable' } });
    const page = await ext.page(PAGES.newtab);
    const duration = await page.locator('.world-scene').evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(duration).toBe('0s');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('every panel is clickable and tabbable in path order', async () => {
    const page = await ext.page(PAGES.newtab);
    const second = page.locator('[data-story]', { hasText: 'Second story' });
    await second.focus();
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain('Second story');
    await page.keyboard.press('Tab');
    const next = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest('[data-place]')?.textContent ?? '');
    expect(next).toMatch(/Third story|Recap/);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('Reduce Motion and a narrow window both get the flat Edition', async () => {
    const page = await ext.ctx.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`chrome-extension://${ext.id}/${PAGES.newtab}`);
    await expect.poll(() => page.locator('main.edition').count()).toBe(1);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 800, height: 900 });
    await page.waitForTimeout(300);
    expect(await page.locator('main.world').count()).toBe(0);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('a focus session brings the fog and stops the sky', async () => {
    await seed(ext, { focusSession: { phaseEndsAt: Date.now() + 25 * 60_000, startedAt: Date.now(), focusMinutes: 25 } });
    const page = await ext.page(PAGES.newtab);
    expect(await page.locator('main.world[data-focus]').count()).toBe(1);
    expect(await page.locator('.world-sky[data-running]').count()).toBe(0);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('the pause button turns ambient motion off and on', async () => {
    const page = await ext.page(PAGES.newtab);
    await page.getByRole('button', { name: 'Pause ambient motion' }).click();
    await expect.poll(async () => (await storage<{ ambientMotion?: boolean }>(ext, 'settings')).ambientMotion).toBe(false);
    await expect.poll(() => page.locator('.world-sky[data-running]').count()).toBe(0);
    await page.getByRole('button', { name: 'Resume ambient motion' }).click();
    await expect.poll(async () => (await storage<{ ambientMotion?: boolean }>(ext, 'settings')).ambientMotion).toBe(true);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('switching view keeps the brain dump draft', async () => {
    const page = await ext.page(PAGES.newtab);
    const box = page.getByPlaceholder(/Whatever is looping/);
    await box.fill('call the dentist');
    await box.blur();
    await page.keyboard.press('v');
    await expect.poll(() => page.locator('main.edition').count()).toBe(1);
    expect(await page.getByPlaceholder(/Whatever is looping/).inputValue()).toBe('call the dentist');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('an empty profile shows the signpost, not a void', async () => {
    await seed(ext, { readingProgress: {}, cachedItems: [] });
    const page = await ext.page(PAGES.newtab);
    await expect.poll(() => page.locator('.world-sign').innerText()).toContain('⌘/Ctrl+Shift+E');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('more than nine things leaves a sign pointing to the flat view', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`http://x.e2e.test/${i}`, article(`http://x.e2e.test/${i}`, `Story ${i}`, { updatedAt: Date.now() - i * 3_600_000 })]),
    );
    await seed(ext, { readingProgress: many, cachedItems: Array.from({ length: 6 }, (_, i) => feedItem(`f${i}`, `Feed ${i}`)) });
    const page = await ext.page(PAGES.newtab);
    await expect.poll(() => page.locator('.world-place[data-place]').count()).toBe(9);
    expect(await page.locator('.world-sign').innerText()).toMatch(/^\+\d+ more · V for the flat view$/);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('sky follows a theme switch without a reload', async () => {
    const page = await ext.page(PAGES.newtab);
    const read = () => page.locator('.world-sky').evaluate((c) => getComputedStyle(c).getPropertyValue('--sky-top').trim());
    const light = await read();
    await seed(ext, { settings: { ...OFF, worldView: 'world', theme: 'dark' } });
    await expect.poll(read).not.toBe(light);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
});
