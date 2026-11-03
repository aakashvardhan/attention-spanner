import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NETWORK_NOISE, PAGES, expectA11y, expectClean, horizontalOverflow, launch, seed, shot, type Ext } from './harness';
import { folder, paper } from './seed';

/** Every key the new tab reads, empty: each test seeds over a clean slate. */
const EMPTY = { papers: [], folders: [folder], annotations: [], explainBacks: {}, focusSession: null };

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

  it('loads neither pdf.js nor KaTeX: the reader fetches them on first use', async () => {
    const loaded: string[] = [];
    const record = (r: { url(): string }) => loaded.push(r.url());
    ext.ctx.on('request', record);
    const page = await ext.page(PAGES.newtab);
    await page.locator('.continue-paper').waitFor();
    ext.ctx.off('request', record);
    // The bridges themselves load (every page shares the wasm module that imports them)...
    expect(loaded.some((u) => u.endsWith('/pdf-bridge.mjs'))).toBe(true);
    // ...but not what they bridge to.
    expect(loaded.filter((u) => /\/(pdfjs|katex)\//.test(u))).toEqual([]);
    await page.close();
  });

  it('at 1280px: Continue reading across the top, brain dump and heatmap side by side under it', async () => {
    const page = await ext.page(PAGES.newtab);
    const read = (await page.locator('.edition > .read-section').boundingBox())!;
    const now = (await page.locator('.edition > .now-col').boundingBox())!;
    const heat = (await page.locator('.edition > .heat-col').boundingBox())!;
    expect(now.y).toBeGreaterThanOrEqual(read.y + read.height);
    expect(heat.y).toBe(now.y);
    expect(now.x + now.width).toBeLessThanOrEqual(heat.x);
    expect(await page.locator('.now-col > section[aria-label="Brain dump"]').count()).toBe(1);
    expect(await page.locator('.heat-col > .heat').count()).toBe(1);
    // The heatmap has room for its whole year: nothing spills past its column.
    const heatInner = await page.locator('.heat').evaluate((e) => e.scrollWidth - e.clientWidth);
    expect(heatInner).toBeLessThanOrEqual(0);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('stacks under 720px with no sideways scroll', async () => {
    const page = await ext.page(PAGES.newtab);
    await page.setViewportSize({ width: 600, height: 900 });
    const read = (await page.locator('.read-section').boundingBox())!;
    const now = (await page.locator('.now-col').boundingBox())!;
    const heat = (await page.locator('.heat-col').boundingBox())!;
    expect(now.y).toBeGreaterThanOrEqual(read.y + read.height);
    expect(heat.y).toBeGreaterThanOrEqual(now.y + now.height);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('shows the open gaps from the last explain-back, each linking to its page, and the rest of the desk', async () => {
    await seed(ext, {
      papers: [
        paper('1', 'Older paper', { lastReadAt: Date.now() - 3 * 60 * 60_000, progressPercent: 40 }),
        paper('2', 'Latest paper', { lastReadAt: Date.now() - 60_000, leftOff: '3.2 Attention' }),
        paper('3', 'Finished paper', { lastReadAt: Date.now() - 2 * 60 * 60_000, progressPercent: 100 }),
      ],
      explainBacks: {
        'arxiv:2601.00002': [
          { at: 1, problem: '', trick: '', why: '', grades: [{ part: 'trick', status: 'missing', gap: 'An older gap.', page: 2 }] },
          {
            at: 2,
            problem: 'p',
            trick: 't',
            why: '',
            grades: [
              { part: 'problem', status: 'got', gap: '', page: null },
              { part: 'trick', status: 'partial', gap: 'You named the layer but not what it attends to.', page: 4 },
              { part: 'why', status: 'missing', gap: 'Nothing on why it scales.', page: null },
            ],
          },
        ],
      },
    });
    const page = await ext.page(PAGES.newtab);
    const gaps = page.locator('.continue-gaps li');
    await expect.poll(() => gaps.count()).toBe(2);
    expect(await gaps.allInnerTexts()).toEqual([
      expect.stringContaining('The key trick: You named the layer but not what it attends to.'),
      'Why it works: Nothing on why it scales.',
    ]);
    const jump = gaps.first().locator('a.gap-page');
    expect(await jump.innerText()).toBe('Page 4');
    expect(await jump.getAttribute('href')).toMatch(/reader\/index\.html\?src=.*2601\.00002.*#page=4$/);
    // Finished papers are not on the desk; the one in Continue is not repeated.
    expect(await page.locator('.also .row-title').allInnerTexts()).toEqual(['Older paper']);
    await expectA11y(page, 'newtab');
    await shot(page, 'newtab-gaps');
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
