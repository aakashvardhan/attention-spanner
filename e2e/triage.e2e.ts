import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NETWORK_NOISE, PAGES, expectA11y, expectClean, launch, seed, storage, type Ext } from './harness';
import { startOllamaMock } from './ollamaMock';
import { article, feedItem } from './seed';

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

  it('one story from three feeds is one row, and opening it reads all three', async () => {
    // One vector per story, named outright: hashed fallbacks could collide and
    // merge two unrelated test items.
    const axis = (i: number) => Array.from({ length: 8 }, (_, j) => (j === i ? 1 : 0));
    const ollama = await startOllamaMock({ fusion: axis(0), compiler: axis(1), rust: axis(2) });
    const finished = article('http://read.e2e.test/x', 'Notes on fusion energy', { completedAt: Date.now() - 3_600_000, maxPercent: 100 });
    const story = [
      feedItem('f1', 'Fusion breakthrough at NIF', { source: 'Ars' }),
      feedItem('f2', 'NIF fusion milestone', { source: 'Verge' }),
      feedItem('f3', 'Fusion record announced', { source: 'Wired' }),
    ];
    await seed(ext, {
      cachedItems: [...story, feedItem('o1', 'A compiler release'), feedItem('o2', 'Rust 2.0 is out')],
      readItems: [],
      readingProgress: { [finished.url]: finished },
      settings: { ollamaUrl: ollama.url, ollamaEmbedModel: 'nomic-embed-text', layaUrl: '', mutedTopics: [] },
    });
    const page = await ext.page(PAGES.newtab);
    const rows = page.locator('.edition-feed .edition-story');
    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBe(3);
    const fusionRow = rows.filter({ hasText: 'Fusion' });
    expect(await fusionRow.locator('.edition-story-meta').innerText()).toMatch(/\+2 sources$/);

    const opened = ext.ctx.waitForEvent('page');
    await fusionRow.click();
    await (await opened).close();
    await expect.poll(() => storage<string[]>(ext, 'readItems')).toEqual(expect.arrayContaining(['f1', 'f2', 'f3']));
    expectClean(ext, NETWORK_NOISE);
    await page.close();
    await ollama.close();
  });

  it('Ollama down: newest first, nothing grouped, and the card says why', async () => {
    await seed(ext, {
      cachedItems: [feedItem('f1', 'Fusion one'), feedItem('f2', 'Fusion two')],
      readItems: [],
      readingProgress: { x: article('http://read.e2e.test/y', 'Read', { completedAt: Date.now(), maxPercent: 100 }) },
      settings: { ...OFF, mutedTopics: [] },
    });
    const page = await ext.page(PAGES.newtab);
    await expect.poll(() => page.locator('.edition-feed .edition-story').count()).toBe(2);
    expect(await page.locator('.edition-feed .relay-triage-note').first().innerText()).toContain('local AI is off');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
});
