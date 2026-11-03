import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { NETWORK_NOISE, PAGES, expectClean, launch, seed, type Ext } from './harness';
import { folder, paper } from './seed';

/**
 * A heavy shelf: 500 papers across 10 folders and 2000 annotations. Budgets are
 * wall-clock with headroom for CI.
 * ponytail: tighten once a few CI runs show the real numbers.
 */
const BUDGET = { firstPaintMs: 2500, longestTaskMs: 600 };

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

describe('load: a heavy shelf stays fast', () => {
  let ext: Ext;
  beforeAll(async () => {
    ext = await launch();
    const folders = Array.from({ length: 10 }, (_, i) => ({ ...folder, id: `${folder.id.slice(0, -2)}${String(i).padStart(2, '0')}`, name: `Shelf ${i}` }));
    await seed(ext, {
      folders,
      papers: Array.from({ length: 500 }, (_, i) =>
        paper(String(i), `Paper ${i}`, { folderIds: [folders[i % 10].id], lastReadAt: Date.now() - i * 60_000 }),
      ),
    });
  });
  afterAll(async () => ext.close());
  beforeEach(() => void ext.errors.splice(0));

  for (const [name, path, ready] of [
    ['new tab', PAGES.newtab, '.continue-paper'],
    ['papers', PAGES.papers, '.book'],
  ] as const) {
    it(`${name} paints within budget, with no long task over budget`, async () => {
      const page = await ext.ctx.newPage();
      const start = Date.now();
      await page.goto(`chrome-extension://${ext.id}/${path}`);
      await page.locator(ready).first().waitFor();
      expect(Date.now() - start).toBeLessThan(BUDGET.firstPaintMs);
      expect(await longestTask(page)).toBeLessThan(BUDGET.longestTaskMs);
      expectClean(ext, NETWORK_NOISE);
      await page.close();
    });
  }
});
