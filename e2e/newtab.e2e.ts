import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NETWORK_NOISE, PAGES, expectA11y, expectClean, horizontalOverflow, launch, seed, shot, storage, type Ext } from './harness';
import { folder, paper } from './seed';

/** Every key the new tab reads, empty: each test seeds over a clean slate. */
const EMPTY = { papers: [], folders: [folder], annotations: [], explainBacks: {}, focusSession: null, todos: [], pomodoro: null };

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

  it('fits one screen: focus first, three columns sharing top and bottom lines, completed sections collapsed', async () => {
    await seed(ext, {
      papers: [
        paper('1', 'Older paper', { lastReadAt: Date.now() - 3 * 60 * 60_000 }),
        paper('3', 'SimToolReal: An Object-Centric Policy for Zero-Shot Dexterous Tool Manipulation', { lastReadAt: Date.now() - 60_000, leftOff: 'Problem Formulation' }),
      ],
      todos: [
        { id: 'a', text: 'Call leasing office tomorrow about rent increase.', dueAt: null, doneAt: null },
        { id: 'b', text: 'Apply to 5 new grad jobs.', dueAt: null, doneAt: null, startedAt: Date.now() },
      ],
    });
    const page = await ext.page(PAGES.newtab);
    for (const [width, height] of [[1280, 720], [1440, 900], [1920, 1080], [1024, 768]]) {
      await page.setViewportSize({ width, height });
      const [focus, read, todos, side] = await Promise.all(
        ['.focus-home', READING_BOARD, '.edition > .board--todos', '.edition > .side-col'].map(async sel => (await page.locator(sel).boundingBox())!),
      );
      expect(focus.y + focus.height, `${width}x${height}`).toBeLessThanOrEqual(read.y);
      for (const col of [todos, side]) {
        expect(Math.abs(col.y - read.y), `${width}x${height} top`).toBeLessThanOrEqual(1);
        expect(Math.abs(col.y + col.height - (read.y + read.height)), `${width}x${height} bottom`).toBeLessThanOrEqual(1);
      }
      expect(read.x < todos.x && todos.x < side.x).toBe(true);
      // One card height on both boards, and the first cards share a row across the columns.
      const heights = await page.locator('.paper-card, .board--todos .todo').evaluateAll(cs => cs.map(c => Math.round(c.getBoundingClientRect().height)));
      expect(new Set(heights).size, `${width}x${height} card heights ${heights}`).toBe(1);
      const firstTops = await Promise.all([`${IN_PROGRESS} .paper-card`, '[aria-labelledby="todo-col-0"] .todo'].map(async s => (await page.locator(s).first().boundingBox())!.y));
      expect(Math.abs(firstTops[0] - firstTops[1]), `${width}x${height} first row`).toBeLessThanOrEqual(1);
      // The page is the window: nothing below the fold, long lists scroll in their column.
      expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), `${width}x${height}`).toBeLessThanOrEqual(0);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await page.locator(`${COMPLETED} details`).getAttribute('open')).toBeNull();
    expect(await page.locator('[aria-labelledby="todo-col-2"] details').getAttribute('open')).toBeNull();
    expect(await page.locator('.news-disclosure').getAttribute('open')).toBeNull();
    expect(await page.locator('.heat').evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
    await expectA11y(page, 'newtab');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('keeps focus above the boards in a narrow window without sideways scroll', async () => {
    const page = await ext.page(PAGES.newtab);
    await page.setViewportSize({ width: 600, height: 900 });
    const start = await page.getByRole('button', { name: 'Start a focus round' }).boundingBox();
    expect(start!.y + start!.height).toBeLessThan(900);
    const [read, todos, side] = await Promise.all(
      [READING_BOARD, '.edition > .board--todos', '.edition > .side-col'].map(async sel => (await page.locator(sel).boundingBox())!),
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
    await page.locator(`${TO_READ} summary`).click();
    await page.locator(`${COMPLETED} summary`).click();
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

  it('starts focus from a board task and keeps completion, edits and reopening in sync', async () => {
    await seed(ext, { todos: [{ id: 'read', text: 'Read section two', dueAt: null, doneAt: null }, { id: 'mail', text: 'Answer mail', dueAt: null, doneAt: null }] });
    const page = await ext.page(PAGES.newtab);
    await page.locator('[data-todo-id="read"]').getByRole('button', { name: 'Focus', exact: true }).click();
    await expect.poll(async () => (await storage<{ tasks: { todoId: string }[] }>(ext, 'pomodoro'))?.tasks[0]?.todoId).toBe('read');
    // During a round another task's button only moves it to In progress; the round keeps its one task.
    await page.locator('[data-todo-id="mail"]').getByRole('button', { name: 'Start', exact: true }).click();
    await expect.poll(async () => (await storage<{ id: string; startedAt: number | null }[]>(ext, 'todos')).find((t) => t.id === 'mail')?.startedAt).toBeTruthy();
    expect((await storage<{ tasks: unknown[] }>(ext, 'pomodoro')).tasks.length).toBe(1);
    const round = page.getByRole('region', { name: 'Focus round' });
    const board = page.locator('[data-todo-id="read"]');
    const text = board.getByRole('textbox', { name: 'Edit task: Read section two', exact: true });
    expect(await text.evaluate(e => getComputedStyle(e).textDecorationLine)).toBe('none');
    await text.fill('Read section three');
    await text.blur();
    await expect.poll(() => round.getByRole('checkbox', { name: 'Read section three' }).count()).toBe(1);
    await round.getByRole('checkbox', { name: 'Read section three' }).check();
    await expect.poll(async () => (await storage<{ doneAt: number | null }[]>(ext, 'todos'))[0].doneAt).not.toBeNull();
    await page.locator('[aria-labelledby="todo-col-2"] summary').click();
    await board.getByRole('button', { name: 'Reopen' }).click();
    await expect.poll(() => round.getByRole('checkbox').isChecked()).toBe(false);
    await board.getByRole('button', { name: 'Done', exact: true }).click();
    await expect.poll(() => round.getByRole('checkbox').isChecked()).toBe(true);
    expect(await page.locator('.news-disclosure').count()).toBe(0);
    await round.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => storage(ext, 'pomodoro')).toBeNull();
    await expectA11y(page, 'newtab');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('chooses board tasks and allows only the chosen study video until focus ends', async () => {
    await seed(ext, { todos: Array.from({ length: 4 }, (_, i) => ({ id: `task-${i}`, text: `Task ${i}`, doneAt: null })) });
    const page = await ext.page(PAGES.newtab);
    const round = page.getByRole('region', { name: 'Focus round' });
    await round.getByRole('button', { name: 'Start a focus round' }).click();
    expect(await round.getByRole('checkbox', { name: 'Task 3', exact: true }).isDisabled()).toBe(true);
    await round.getByRole('checkbox', { name: 'Task 0', exact: true }).uncheck();
    await round.getByRole('checkbox', { name: 'Task 3', exact: true }).check();
    await page.getByLabel('Study video', { exact: false }).fill('https://youtube.com/watch?v=abcdefghijk');
    await round.getByRole('button', { name: 'Start focus', exact: true }).click();
    await expect.poll(async () => (await storage<{ studyVideo: string }>(ext, 'pomodoro'))?.studyVideo).toBe('abcdefghijk');
    const matched = (url: string) => ext.sw.evaluate(async u =>
      (await chrome.declarativeNetRequest.testMatchOutcome({ url: u, type: 'main_frame' })).matchedRules.map(r => r.ruleId), url);
    await expect.poll(() => matched('https://www.youtube.com/watch?v=abcdefghijk&t=30')).toContain(902);
    expect(await matched('https://www.youtube.com/watch?v=other_video')).not.toContain(902);
    for (const url of ['https://www.youtube.com/shorts/abcdefghijk', 'https://music.youtube.com/watch?v=abcdefghijk', 'https://youtu.be/abcdefghijk'])
      expect(await matched(url), url).toContain(902);
    // YouTube plays the first v=, so a later one must not unlock it.
    expect(await matched('https://www.youtube.com/watch?v=other_video&v=abcdefghijk')).not.toContain(902);
    expect((await matched('https://www.youtube.com/watch?v=other_video')).some(id => id >= 1000 && id < 2000)).toBe(true);
    await ext.ctx.route('https://www.youtube.com/watch?v=abcdefghijk', route => route.fulfill({ contentType: 'text/html', body: '<main>Lecture</main>' }));
    const lecture = await ext.ctx.newPage();
    await lecture.goto('https://www.youtube.com/watch?v=abcdefghijk');
    await lecture.evaluate(() => history.pushState({}, '', '/watch?v=other_video'));
    await lecture.waitForURL(/blocked\/index\.html/);
    await lecture.close();
    await round.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => matched('https://www.youtube.com/watch?v=abcdefghijk')).not.toContain(902);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('advances an expired round into a break and removes its study-video allowance', async () => {
    const now = Date.now();
    await seed(ext, {
      pomodoro: { phase: 'focus', startedAt: now - 25 * 60_000, endsAt: now - 1,
        tasks: [{ text: 'An older round', done: false }], studyVideo: 'abcdefghijk' },
    });
    await expect.poll(async () => (await storage<{ phase: string }>(ext, 'pomodoro'))?.phase).toBe('break');
    const page = await ext.page(PAGES.newtab);
    const round = page.getByRole('region', { name: 'Focus round' });
    expect(await round.getByRole('checkbox', { name: 'An older round' }).count()).toBe(1);
    await expect.poll(() => ext.sw.evaluate(async () =>
      (await chrome.declarativeNetRequest.getSessionRules()).some(r => r.id === 902))).toBe(false);
    await round.getByRole('button', { name: 'End break' }).click();
    await expect.poll(() => storage(ext, 'pomodoro')).toBeNull();
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
});
