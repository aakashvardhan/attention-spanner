import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGES, launch, type Ext } from './harness';
import { makePdf } from './seed';

/** Opening a paper that is already open sends you to that tab instead of a second copy. */
describe('reader: one tab per paper', () => {
  let ext: Ext;
  let url: string;

  beforeAll(async () => {
    ext = await launch();
    const pdf = makePdf(2);
    ext.sites.setRoute('papers', '/paper.pdf', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(pdf);
    });
    url = `${PAGES.reader}?src=${encodeURIComponent(`${ext.sites.origin('papers')}/paper.pdf`)}`;
  });

  afterAll(async () => {
    await ext?.close();
  });

  it('closes the duplicate and tells the first tab', async () => {
    const first = await ext.page(url);
    await first.waitForSelector('[aria-label^="Page 1 of"]');
    const second = await ext.ctx.newPage();
    const closed = second.waitForEvent('close');
    await second.goto(`chrome-extension://${ext.id}/${url}`);
    await closed;
    expect(await first.locator('.reader-dup-toast').textContent()).toBe('This paper is already open. Here it is.');
    expect(ext.ctx.pages().filter((p) => p.url().includes('reader/index.html'))).toHaveLength(1);

    // A #page=N link to the open paper moves the open tab there.
    const third = await ext.ctx.newPage();
    const gone = third.waitForEvent('close');
    await third.goto(`chrome-extension://${ext.id}/${url}#page=2`);
    await gone;
    await expect.poll(() => first.evaluate(() => location.hash)).toBe('#page=2');
    await expect.poll(() => first.locator('.reader-capsule').textContent()).toContain('2');
  });
});
