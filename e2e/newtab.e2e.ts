import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NETWORK_NOISE, PAGES, expectA11y, expectClean, horizontalOverflow, launch, seed, shot, type Ext } from './harness';
import { folder, paper } from './seed';

/** Every key the new tab reads, empty: each test seeds over a clean slate. */
const EMPTY = { papers: [], folders: [folder], annotations: [], explainBacks: {}, focusSession: null };

/** The reading board's columns, by the index the page gives their headings. */
const IN_PROGRESS = 'section[aria-labelledby="board-1"]';
const TO_READ = 'section[aria-labelledby="board-0"]';
const COMPLETED = 'section[aria-labelledby="board-2"]';
const READING_BOARD = '.edition > .board:not(.board--todos)';

describe('new tab: reading board, to-dos, side column', () => {
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
    await page.locator('.paper-card').first().waitFor();
    ext.ctx.off('request', record);
    // The bridges themselves load (every page shares the wasm module that imports them)...
    expect(loaded.some((u) => u.endsWith('/pdf-bridge.mjs'))).toBe(true);
    // ...but not what they bridge to.
    expect(loaded.filter((u) => /\/(pdfjs|katex)\//.test(u))).toEqual([]);
    await page.close();
  });

  it('at 1280px: reading board, hairline, to-do board and side column in one row, ending level', async () => {
    const page = await ext.page(PAGES.newtab);
    const boxes = await Promise.all(
      [READING_BOARD, '.edition > .board-divider', '.edition > .board--todos', '.edition > .side-col'].map(
        async (sel) => (await page.locator(sel).boundingBox())!,
      ),
    );
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].x).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width);
      expect(Math.abs(boxes[i].y - boxes[0].y)).toBeLessThanOrEqual(1);
      expect(Math.abs(boxes[i].y + boxes[i].height - (boxes[0].y + boxes[0].height))).toBeLessThanOrEqual(1);
    }
    expect(await page.locator('.side-col > section[aria-label="Brain dump"]').count()).toBe(1);
    expect(await page.locator('.side-col > .heat').count()).toBe(1);
    // The heatmap has room for its whole year: nothing spills past its column.
    const heatInner = await page.locator('.heat').evaluate((e) => e.scrollWidth - e.clientWidth);
    expect(heatInner).toBeLessThanOrEqual(0);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('stacks in one column under 640px with no sideways scroll', async () => {
    const page = await ext.page(PAGES.newtab);
    await page.setViewportSize({ width: 600, height: 900 });
    const [read, todos, side] = await Promise.all(
      [READING_BOARD, '.edition > .board--todos', '.edition > .side-col'].map(async (sel) => (await page.locator(sel).boundingBox())!),
    );
    expect(todos.y).toBeGreaterThanOrEqual(read.y + read.height);
    expect(side.y).toBeGreaterThanOrEqual(todos.y + todos.height);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('sorts papers into In progress, To read and Completed, and the paper read last lists its open gaps', async () => {
    await seed(ext, {
      papers: [
        paper('1', 'Older paper', { lastReadAt: Date.now() - 3 * 60 * 60_000, progressPercent: 40 }),
        paper('2', 'Latest paper', { lastReadAt: Date.now() - 60_000, leftOff: '3.2 Attention' }),
        paper('3', 'Finished paper', { lastReadAt: Date.now() - 2 * 60 * 60_000, progressPercent: 100 }),
        paper('4', 'Unopened paper', { lastReadAt: null, progressPercent: 0 }),
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
    const titles = (col: string) => page.locator(`${col} .paper-card-title`).allInnerTexts();
    await expect.poll(() => titles(IN_PROGRESS)).toEqual(['Latest paper', 'Older paper']);
    expect(await titles(TO_READ)).toEqual(['Unopened paper']);
    expect(await titles(COMPLETED)).toEqual(['Finished paper']);

    // Only the latest explain-back counts, and only on the paper read last.
    const gaps = page.locator('.paper-card-gaps li');
    expect(await gaps.count()).toBe(2);
    expect(await gaps.allInnerTexts()).toEqual([
      expect.stringContaining('The key trick: You named the layer but not what it attends to.'),
      'Why it works: Nothing on why it scales.',
    ]);
    const jump = gaps.first().locator('a.gap-page');
    expect(await jump.innerText()).toBe('p. 4');
    expect(await jump.getAttribute('href')).toMatch(/reader\/index\.html\?src=.*2601\.00002.*#page=4$/);
    await expectA11y(page, 'newtab');
    await shot(page, 'newtab-gaps');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('the first In progress card shows where you stopped and opens the paper in the reader', async () => {
    const page = await ext.page(PAGES.newtab);
    const link = page.locator(`${IN_PROGRESS} .paper-card-link`).first();
    await expect.poll(() => link.innerText()).toContain('Latest paper');
    expect(await link.innerText()).toContain('3.2 Attention');
    await expectA11y(page, 'newtab');
    expect(await link.getAttribute('href')).toMatch(/reader\/index\.html\?src=.*2601\.00002/);
    await link.click();
    await page.waitForURL(/reader\/index\.html\?src=.*2601\.00002/);
    await page.close();
  });

  it('empty profile: every reading column says so, no errors', async () => {
    await seed(ext, EMPTY);
    const page = await ext.page(PAGES.newtab);
    await expect.poll(() => page.locator(`${READING_BOARD} .board-empty`).count()).toBe(3);
    expect(await page.locator('.paper-card').count()).toBe(0);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('at rest only the clock hands move, and with reduced motion the second hand stops', async () => {
    const moving = async (page: import('playwright').Page) => {
      await page.waitForTimeout(2000);
      return page.evaluate(() =>
        document.getAnimations().map((a) => ((a.effect as KeyframeEffect | null)?.target as Element | null)?.getAttribute('class') ?? '?'),
      );
    };
    const page = await ext.page(PAGES.newtab);
    const running = await moving(page);
    expect(running.length).toBeGreaterThan(0);
    expect(running.filter((c) => !c.includes('clock-hand'))).toEqual([]);
    // The hour and minute hands turn too slowly to see; the sweep is the one that visibly moves.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect((await moving(page)).sort()).toEqual(['clock-hand clock-hand-h', 'clock-hand clock-hand-m']);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
});
