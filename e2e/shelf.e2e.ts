import type { Route } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PAGES, expectA11y, expectClean, launch, seed, shot, storage, type Ext } from './harness';
import { folder, paper } from './seed';

const done = { id: '01985f0e-9788-7924-8401-000000000003', name: 'Completed', type: 'default-completed' };
const SIGNED_IN = {
  alphaxivAuth: { clientId: 'c', redirectUri: 'r', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 },
  // Synced just now, so opening the page does not pull the library over the seed.
  alphaxivStatus: { email: 'me@example.edu', lastSyncAt: Date.now(), error: '' },
  alphaxivPush: [],
};

/** alphaXiv's MCP server, scripted per tool; every tool call is recorded with its arguments. */
async function mockAlphaxiv(ext: Ext, tools: Record<string, (args: Record<string, unknown>) => string | null>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  await ext.ctx.unroute('https://api.alphaxiv.org/mcp/v1');
  await ext.ctx.route('https://api.alphaxiv.org/mcp/v1', async (route: Route) => {
    const body = route.request().postDataJSON() as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
    if (body.method === 'initialize')
      return route.fulfill({ headers: { 'mcp-session-id': 's1' }, json: { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } } } });
    if (body.method === 'notifications/initialized') return route.fulfill({ status: 202, body: '' });
    const name = body.params?.name ?? '';
    calls.push({ name, args: body.params?.arguments ?? {} });
    const text = tools[name]?.(body.params?.arguments ?? {});
    if (text === null || text === undefined) return route.fulfill({ status: 500, body: '' });
    return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }] } } });
  });
  return calls;
}

const EMPTY_FEED = '{"papers":[]}';

describe('papers: the bookcase', () => {
  let ext: Ext;
  beforeAll(async () => {
    ext = await launch();
  });
  afterAll(async () => ext.close());
  beforeEach(async () => {
    ext.errors.splice(0);
    await seed(ext, {
      ...SIGNED_IN,
      folders: [folder, done],
      papers: [
        paper('1', 'Mamba: Linear-Time Sequence Modeling with Selective State Spaces', {
          year: 2023,
          progressPercent: 60,
          leftOff: '3.2 Selective scan',
          pdf: { url: 'https://arxiv.org/pdf/2601.00001', page: 7, pageCount: 36, offset: 0 },
          lastReadAt: Date.now() - 60_000,
        }),
        paper('2', 'Attention Is All You Need', { year: 2017, progressPercent: 0, lastReadAt: Date.now() - 120_000 }),
        paper('3', 'Denoising Diffusion Probabilistic Models', { year: 2020, progressPercent: 100, folderIds: [done.id] }),
      ],
      explainBacks: {
        'arxiv:2601.00001': [
          {
            at: Date.now(),
            problem: 'p',
            trick: 't',
            why: '',
            grades: [
              { part: 'problem', status: 'got', gap: '', page: null },
              { part: 'why', status: 'missing', gap: 'You did not say why the scan stays linear.', page: 9 },
            ],
          },
        ],
      },
    });
  });

  it('walks the books by keyboard, pulls one out with its open gaps, and puts it back', async () => {
    await mockAlphaxiv(ext, { get_hot_feed: () => EMPTY_FEED, get_for_you_feed: () => EMPTY_FEED });
    const page = await ext.page(PAGES.papers);
    const books = page.locator('.book');
    await expect.poll(() => books.count()).toBe(3);
    // Each book shows its title, byline and progress; the name carries the title and progress.
    const book = page.locator('#book-0-0');
    await expect.poll(() => book.locator('.book-title').textContent()).toBe('Mamba: Linear-Time Sequence Modeling with Selective State Spaces');
    expect(await book.locator('.book-meta').textContent()).toBe('A. Author · 2023');
    expect(await book.locator('.book-foot').textContent()).toBe('60% read');
    expect(await book.getAttribute('aria-label')).toBe('Mamba: Linear-Time Sequence Modeling with Selective State Spaces. 60% read.');
    expect(await page.locator('#book-0-1 .book-foot').textContent()).toBe('not started');

    // One tab stop for the case; arrows walk it.
    expect(await page.locator('.book[tabindex="0"]').count()).toBe(1);
    await page.locator('#book-0-0').focus();
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('book-0-1');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('book-1-0');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowLeft');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('book-0-0');
    await shot(page, 'shelf-focused');

    await page.keyboard.press('Enter');
    const card = page.locator('.book-card[role="dialog"]');
    await card.waitFor();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('book-card-continue');
    const text = await card.textContent();
    expect(text).toContain('3.2 Selective scan');
    expect(text).toContain('Why it works: You did not say why the scan stays linear. (page 9)');
    expect(text).not.toContain('The problem:');
    expect(await page.locator('#book-card-continue').getAttribute('href')).toContain('src/pages/reader/index.html');
    await expectA11y(page, 'papers');
    await shot(page, 'shelf-card');
    await page.keyboard.press('Escape');
    expect(await card.count()).toBe(0);
    // Focus goes back to the book on the next frame.
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('book-0-0');
    expectClean(ext);
    await page.close();
  });

  it('moves a book with M at once, and puts it back when alphaXiv refuses', async () => {
    let refuse = false;
    const calls = await mockAlphaxiv(ext, {
      get_hot_feed: () => EMPTY_FEED,
      get_for_you_feed: () => EMPTY_FEED,
      move_papers_between_folders: () => (refuse ? null : '{"moved":1}'),
    });
    const page = await ext.page(PAGES.papers);
    await page.locator('#book-0-1').focus();
    await page.keyboard.press('m');
    const menu = page.locator('.move-menu[role="dialog"]');
    await menu.waitFor();
    expect(await menu.locator('li button').allTextContents()).toEqual(['Completed']);
    await page.keyboard.press('Enter');
    const folders = async () => (await storage<{ id: string; folderIds: string[] }[]>(ext, 'papers')).find((p) => p.id === '2601.00002')?.folderIds;
    await expect.poll(folders).toEqual([done.id]);
    await expect.poll(() => page.locator('.library-status').textContent()).toBe('Moved to Completed.');
    expect(calls.at(-1)).toEqual({
      name: 'move_papers_between_folders',
      args: { paper_ids_or_urls: ['2601.00002'], from_folder_id: folder.id, to_folder_id: done.id },
    });

    // Refused: the book goes back, and the page says so.
    refuse = true;
    await expect.poll(() => page.locator('.shelf').nth(1).locator('.book').count()).toBe(2);
    await page.locator('.shelf').nth(1).locator('.book').first().focus();
    await page.keyboard.press('M');
    await menu.locator('li button', { hasText: 'Reading' }).click();
    await expect.poll(() => page.locator('.library-status').textContent()).toMatch(/^Not moved: /);
    expect((await storage<{ id: string; folderIds: string[] }[]>(ext, 'papers')).map((p) => p.folderIds)).toEqual([[folder.id], [done.id], [done.id]]);
    expectClean(ext, [/status of 500/]);
    await page.close();
  });

  it('moves a book by dragging it to another shelf', async () => {
    const calls = await mockAlphaxiv(ext, {
      get_hot_feed: () => EMPTY_FEED,
      get_for_you_feed: () => EMPTY_FEED,
      move_papers_between_folders: () => '{"moved":1}',
    });
    const page = await ext.page(PAGES.papers);
    await page.locator('#book-0-0').dragTo(page.locator('.shelf').nth(1));
    await expect.poll(() => calls.filter((c) => c.name === 'move_papers_between_folders').length).toBe(1);
    await expect.poll(() => page.locator('.shelf').nth(1).locator('.book').count()).toBe(2);
    expectClean(ext);
    await page.close();
  });

  it('shelves a new arrival with S, titled from arXiv', async () => {
    let saved = false;
    const calls = await mockAlphaxiv(ext, {
      get_hot_feed: () => '{"papers":[{"universal_paper_id":"2610.00001"},{"universal_paper_id":"2601.00001"}]}',
      get_for_you_feed: () => '{"papers":[{"universal_paper_id":"2610.00002"}]}',
      save_papers_to_folder: () => ((saved = true), '{"saved":1}'),
      list_library: () =>
        JSON.stringify({
          folders: [
            { folder_id: folder.id, name: 'Reading', type: 'default-reading', papers: [{ universal_paper_id: '2601.00001', title: 'Mamba', type: 'public' }, { universal_paper_id: '2601.00002', title: 'Attention Is All You Need', type: 'public' }].concat(saved ? [{ universal_paper_id: '2610.00001', title: 'A Hot Paper', type: 'public' }] : []), papers_truncated: false },
            { folder_id: done.id, name: 'Completed', type: 'default-completed', papers: [{ universal_paper_id: '2601.00003', title: 'Denoising Diffusion Probabilistic Models', type: 'public' }], papers_truncated: false },
          ],
        }),
    });
    await ext.ctx.route('https://export.arxiv.org/api/query**', (route) =>
      route.fulfill({
        contentType: 'application/atom+xml',
        body: '<feed><entry><id>http://arxiv.org/abs/2610.00001v1</id><title>A Hot\n  Paper</title></entry><entry><id>http://arxiv.org/abs/2610.00002v1</id><title>One For You</title></entry></feed>',
      }),
    );
    const page = await ext.page(PAGES.papers);
    const cart = page.locator('section.cart');
    await cart.waitFor();
    // Already on the shelf (2601.00001) is left out of the cart.
    expect(await cart.locator('.cart-item a').allTextContents()).toEqual(['A Hot Paper', 'One For You']);
    await cart.locator('.cart-item a', { hasText: 'A Hot Paper' }).focus();
    await page.keyboard.press('s');
    await page.locator('.move-menu li button', { hasText: 'Reading' }).click();
    await expect.poll(() => page.locator('.library-status').textContent()).toBe('Shelved in Reading.');
    expect(calls.find((c) => c.name === 'save_papers_to_folder')?.args).toEqual({ paper_ids_or_urls: ['2610.00001'], folder_id: folder.id });
    await expect.poll(async () => (await storage<{ id: string; title: string }[]>(ext, 'papers')).find((p) => p.id === '2610.00001')?.title).toBe('A Hot Paper');
    await expect.poll(() => cart.locator('.cart-item a').allTextContents()).toEqual(['One For You']);
    await expectA11y(page, 'papers');
    await shot(page, 'shelf-cart');
    expectClean(ext);
    await page.close();
  });
});
