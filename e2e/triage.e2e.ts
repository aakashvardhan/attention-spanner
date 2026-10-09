import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NETWORK_NOISE, PAGES, expectA11y, expectClean, launch, seed, type Ext } from './harness';
import { feedItem } from './seed';

const OFF = { ollamaUrl: 'http://127.0.0.1:9', layaUrl: '' }; // nothing listens on port 9

describe('triage card and muted topics', () => {
  let ext: Ext;
  beforeAll(async () => {
    ext = await launch();
  });
  afterAll(async () => ext.close());
  beforeEach(() => void ext.errors.splice(0));

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
