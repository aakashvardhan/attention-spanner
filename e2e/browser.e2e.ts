import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGES, expectClean, launch, seed, storage, NETWORK_NOISE, type Ext } from './harness';
import { makePdf, paper } from './seed';

/**
 * The browser's own surfaces: the tab title, the toolbar badge, keyboard
 * commands, the omnibox keyword and the context menus, plus the reader's keys.
 * Chrome's UI cannot be clicked from here, so each listener is fired from the
 * worker, as the side-panel suite fires the icon.
 */
describe('browser surfaces', () => {
  let ext: Ext;
  let reader: string;
  const badge = () => ext.sw.evaluate(() => chrome.action.getBadgeText({}));

  beforeAll(async () => {
    ext = await launch();
    const pdf = makePdf(4, true);
    ext.sites.setRoute('papers', '/sections.pdf', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(pdf);
    });
    reader = `${PAGES.reader}?src=${encodeURIComponent(`${ext.sites.origin('papers')}/sections.pdf`)}`;
  });

  afterAll(async () => {
    await ext?.close();
  });

  it('the reader names its tab, shows the section, answers its keys, and dots the badge', async () => {
    const page = await ext.page(reader);
    await expect.poll(() => page.title()).toMatch(/sections\.pdf · p\. 1\/4$/);
    await expect.poll(() => page.locator('.reader-section-name').innerText()).toBe('Section 1');
    await expect.poll(badge).toBe('•');

    await page.keyboard.press('j');
    await expect.poll(() => page.locator('.reader-section-name').innerText()).toBe('Section 2');
    await expect.poll(() => page.title()).toMatch(/p\. 2\/4$/);
    await page.keyboard.press('k');
    await expect.poll(() => page.locator('.reader-section-name').innerText()).toBe('Section 1');

    await page.keyboard.press('?');
    await page.locator('.reader-keys').waitFor();
    expect(await page.locator('.reader-keys dt').count()).toBe(13);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.reader-keys').count()).toBe(0);

    // T opens Talk and closes it again, through the view transition.
    await page.keyboard.press('t');
    await page.locator('.reader-talk').waitFor();
    expect(await page.locator('.talk-orb').getAttribute('data-state')).toBe('off');
    await page.locator('.reader-viewport').focus();
    await page.keyboard.press('t');
    await expect.poll(() => page.locator('.reader-talk').count()).toBe(0);

    await page.close();
    await expect.poll(badge).toBe('');
    expectClean(ext, NETWORK_NOISE);
  });

  it('the focus command starts a round from the top tasks; the badge and the new tab count it down', async () => {
    await seed(ext, {
      papers: [paper('2', 'Attention Is All You Need', { leftOff: '3.2 Attention' }), paper('5', 'Mamba', { lastReadAt: null, progressPercent: 0 })],
      todos: [
        { id: 'a', text: 'Read section 3.2', dueAt: null, doneAt: null, rank: 0 },
        { id: 'b', text: 'Already done', dueAt: null, doneAt: 1, rank: 1 },
      ],
    });
    await ext.sw.evaluate(() => (chrome.commands.onCommand as unknown as { dispatch(c: string): void }).dispatch('focus-round'));
    await expect.poll(async () => (await storage<{ tasks: { text: string }[] } | null>(ext, 'pomodoro'))?.tasks.map((t) => t.text)).toEqual(['Read section 3.2']);
    await expect.poll(badge).toMatch(/^\d+m$/);

    const page = await ext.page(PAGES.newtab);
    await expect.poll(() => page.title()).toMatch(/^\d+ min · Focus$/);
    const resume = page.locator('a.resume');
    expect(await resume.innerText()).toContain('Attention Is All You Need');
    expect(await resume.innerText()).toContain('3.2 Attention');
    expect(await resume.getAttribute('href')).toMatch(/reader\/index\.html\?src=.*2601\.00002/);
    // An unset reminder is out of sight until its card is in hand.
    const when = page.locator('.board--todos .todo-when').first();
    expect(await when.evaluate((e) => getComputedStyle(e).opacity)).toBe('0');
    await when.focus();
    expect(await when.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');

    await seed(ext, { pomodoro: null });
    await expect.poll(badge).toBe('');
    await expect.poll(() => page.title()).toBe('New Tab');
    await page.close();
    expectClean(ext, NETWORK_NOISE);
  });

  it('the omnibox keyword finds a paper by its title words', async () => {
    type Row = { content: string; description: string };
    const suggest = (text: string) =>
      ext.sw.evaluate(
        (t) => new Promise<Row[]>((done) => (chrome.omnibox.onInputChanged as unknown as { dispatch(t: string, s: (r: Row[]) => void): void }).dispatch(t, done)),
        text,
      );
    const rows = await suggest('need attention');
    expect(rows.map((r) => r.description)).toEqual(['Attention Is All You Need <dim>30% read</dim>']);
    expect(rows[0].content).toMatch(/reader\/index\.html\?src=.*2601\.00002/);
    expect(await suggest('diffusion')).toEqual([]);
  });

  it('the context menus open an arXiv link in the reader and keep a selection as a term', async () => {
    const click = (info: Record<string, string>, tab: Record<string, string>) =>
      ext.sw.evaluate(([i, t]) => (chrome.contextMenus.onClicked as unknown as { dispatch(i: unknown, t: unknown): void }).dispatch(i, t), [info, tab]);
    await seed(ext, { lexicon: { terms: [], edges: [] } });
    await click({ menuItemId: 'lexicon', selectionText: ' Residual stream ', pageUrl: 'https://example.com/post' }, { title: 'A post' });
    await expect
      .poll(async () => (await storage<{ terms: { label: string; sources: { paperTitle: string }[] }[] }>(ext, 'lexicon')).terms.map((t) => [t.label, t.sources[0].paperTitle]))
      .toEqual([['Residual stream', 'A post']]);

    const opened = ext.ctx.waitForEvent('page');
    await click({ menuItemId: 'open-reader', linkUrl: 'https://arxiv.org/abs/2601.00009' }, {});
    const page = await opened;
    expect(page.url()).toMatch(/reader\/index\.html\?src=https%3A%2F%2Farxiv\.org%2Fpdf%2F2601\.00009$/);
    await page.close();
  });
});
