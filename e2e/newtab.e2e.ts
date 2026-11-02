import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NETWORK_NOISE, PAGES, expectA11y, expectClean, horizontalOverflow, launch, seed, type Ext } from './harness';
import { folder, paper } from './seed';

/** Every key the new tab reads, empty: each test seeds over a clean slate. */
const EMPTY = { papers: [], folders: [folder], annotations: [], focusSession: null };

describe('new tab: Now / Continue reading', () => {
  let ext: Ext;

  beforeAll(async () => {
    ext = await launch();
  });
  afterAll(async () => ext.close());
  beforeEach(async () => {
    ext.errors.splice(0);
    await seed(ext, {
      ...EMPTY,
      papers: [
        paper('1', 'Older paper', { lastReadAt: Date.now() - 3 * 60 * 60_000 }),
        paper('2', 'Latest paper', { lastReadAt: Date.now() - 60_000, leftOff: '3.2 Attention' }),
      ],
    });
  });

  it('two columns at 1280px: brain dump and heatmap beside Continue reading', async () => {
    const page = await ext.page(PAGES.newtab);
    const now = await page.locator('.edition > .now-col').boundingBox();
    const read = await page.locator('.edition > .read-col').boundingBox();
    expect(now!.x + now!.width).toBeLessThanOrEqual(read!.x);
    expect(await page.locator('.now-col > section[aria-label="Brain dump"]').count()).toBe(1);
    expect(await page.locator('.now-col > .heat').count()).toBe(1);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('stacks under 720px with no sideways scroll', async () => {
    const page = await ext.page(PAGES.newtab);
    await page.setViewportSize({ width: 600, height: 900 });
    const now = await page.locator('.now-col').boundingBox();
    const read = await page.locator('.read-col').boundingBox();
    expect(read!.y).toBeGreaterThanOrEqual(now!.y + now!.height);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('Continue reading shows the paper read last, where you stopped, and opens it in the reader', async () => {
    const page = await ext.page(PAGES.newtab);
    const link = page.locator('.continue-paper');
    await expect.poll(() => link.innerText()).toContain('Latest paper');
    expect(await link.innerText()).toContain('3.2 Attention');
    await expectA11y(page, 'newtab');
    expect(await link.getAttribute('href')).toMatch(/reader\/index\.html\?src=.*2601\.00002/);
    // The Rust build gets its reader in phase 4; until then the link is checked, not followed.
    if (process.env.DIST?.includes('rust')) return void (await page.close());
    await link.click();
    await page.waitForURL(/reader\/index\.html\?src=.*2601\.00002/);
    await page.close();
  });

  it('empty profile: one hint, no errors', async () => {
    await seed(ext, EMPTY);
    const page = await ext.page(PAGES.newtab);
    await expect.poll(() => page.locator('section[aria-labelledby="continue-heading"] .hint').count()).toBe(1);
    expect(await page.locator('.continue-paper').count()).toBe(0);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('no motion: nothing animates after two idle seconds', async () => {
    const page = await ext.page(PAGES.newtab);
    await page.waitForTimeout(2000);
    const moving = await page.evaluate(() =>
      document.getAnimations().map((a) => ((a.effect as KeyframeEffect | null)?.target as Element | null)?.className ?? '?'),
    );
    expect(moving).toEqual([]);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
});
