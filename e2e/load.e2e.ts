import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  beforeEach(() => void ext.errors.splice(0));

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
