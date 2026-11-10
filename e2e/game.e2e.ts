import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PAGES, expectA11y, expectClean, launch, seed, type Ext } from './harness';
import { folder, makePdf, paper } from './seed';

/**
 * The game end to end (rust/core/src/game.rs): level, streak and quests are
 * derived from storage, so every step here is a storage write a real action
 * makes, and the pages must follow it live.
 */

/** The activity log's key for the local day `n` days ago. */
const day = (n: number) => {
  const d = new Date(Date.now() - n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const clocked = (minutes: number) => ({ papers: [], focus: 1, clocked: minutes });
const read = paper('1', 'Denoising Diffusion', { progressPercent: 100 });
const KEY = `arxiv:${read.id}`;
const explained = { at: Date.now(), problem: 'p', trick: 't', why: 'w', grades: [] };
const term = (label: string) => ({
  id: label.toLowerCase(),
  label,
  linkedAt: null,
  sources: [{ docKey: KEY, paperTitle: read.title, definition: 'd', guess: 'my guess', context: 'c', addedAt: Date.now() }],
});
const todo = { id: 'a', text: 'Email advisor', dueAt: null, doneAt: null as number | null };

/** 12 + 35 + 40 minutes, two goal days (+40) and a finished paper (+100): 227 XP, level 2. Yesterday met, the day before forgiven. */
const START = {
  folders: [folder],
  papers: [read],
  activity: { [day(0)]: clocked(12), [day(1)]: clocked(35), [day(3)]: clocked(40) },
  explainBacks: {},
  lexicon: { terms: [], edges: [] },
  todos: [todo],
  focusSession: null,
  pomodoro: null,
};

describe('the game: level, streak and quests across the pages', () => {
  let ext: Ext;
  beforeAll(async () => {
    ext = await launch();
  });
  afterAll(async () => ext.close());
  beforeEach(async () => {
    ext.errors.splice(0);
    await seed(ext, START);
  });

  it('new tab: the card adds up storage, then follows each thing earned', async () => {
    const page = await ext.page(PAGES.newtab);
    const card = page.locator('.game');
    const earned = card.locator('.game-earned');
    const quests = card.locator('.game-quests li');
    await quests.first().waitFor();
    expect(await card.locator('.game-level').innerText()).toBe('Level 2');
    expect(await card.locator('.game-head .hint').innerText()).toBe('Reader · 127 of 200 XP');
    expect(await card.locator('.game-streak').innerText()).toBe('2-day streak');
    expect(await card.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('127');
    expect(await quests.allInnerTexts().then((t) => t.map((s) => s.replace(/\s+/g, ' ')))).toEqual([
      'Read or focus for 20 minutes 12 of 20 min',
      'Explain a paper back, or keep a term Not yet',
      'Finish a to-do Not yet',
    ]);
    // Loading the page earned nothing.
    expect(await earned.innerText()).toBe('');
    await expectA11y(page, 'newtab-game');

    // An explain-back: +30, and the thinking quest is done.
    await seed(ext, { explainBacks: { [KEY]: [explained] } });
    await expect.poll(() => earned.innerText()).toBe('+30 XP');
    expect(await quests.nth(1).getAttribute('class')).toContain('game-quest--done');

    // The day's goal: 8 more minutes and the 20 bonus; the streak now includes today.
    await seed(ext, { activity: { ...START.activity, [day(0)]: clocked(20) } });
    await expect.poll(() => earned.innerText()).toBe('+28 XP · today counts, day 3 of your streak');
    expect(await card.locator('.game-streak').innerText()).toBe('3-day streak');

    // The last quest clears the day.
    await seed(ext, { todos: [{ ...todo, doneAt: Date.now() }] });
    await expect.poll(() => earned.innerText()).toBe('All three quests done today');
    expect(await card.locator('.label').innerText()).toMatch(/today cleared/i);

    // 285 XP; three guessed terms (+15) reach level 3.
    await seed(ext, { lexicon: { terms: ['ELBO', 'Score', 'Schedule'].map(term), edges: [] } });
    await expect.poll(() => earned.innerText()).toBe('Level 3 · Reader');
    expect(await card.locator('.game-level').innerText()).toBe('Level 3');
    expectClean(ext);
    await page.close();
  });

  it('papers: each book carries its three marks, and the card says which are open', async () => {
    await seed(ext, { explainBacks: { [KEY]: [explained] }, lexicon: { terms: [term('ELBO')], edges: [] } });
    const page = await ext.page(PAGES.papers);
    const book = page.locator('.book').first();
    expect(await book.getAttribute('aria-label')).toContain('Read · Explained · 1 of 3 terms');
    expect(await book.locator('.book-marks i[data-on]').count()).toBe(2);
    await book.click();
    expect(await page.locator('.book-card-facts').innerText()).toContain('Read · Explained · 1 of 3 terms');
    await page.keyboard.press('Escape');
    // The third mark fills in live.
    await seed(ext, { lexicon: { terms: ['ELBO', 'Score', 'Schedule'].map(term), edges: [] } });
    await expect.poll(() => page.locator('.book').first().locator('.book-marks i[data-on]').count()).toBe(3);
    expectClean(ext);
    await page.close();
  });

  it('blocked page: the streak and the minutes still to go, the running round counted', async () => {
    const now = Date.now();
    await seed(ext, { pomodoro: { phase: 'focus', startedAt: now - 5.5 * 60_000, endsAt: now + 19.5 * 60_000, tasks: [{ text: 'Email advisor', done: false }] } });
    const page = await ext.page(PAGES.blocked);
    await expect.poll(() => page.locator('.blocked-inner').innerText()).toContain('Day 2 of your streak. 3 minutes to go today.');
    expectClean(ext);
    await page.close();
  });

  it('reader: what is earned while reading shows in the capsule', async () => {
    const pdf = makePdf(2);
    ext.sites.setRoute('papers', '/game.pdf', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(pdf);
    });
    const page = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(`${ext.sites.origin('papers')}/game.pdf`)}`);
    await page.locator('.reader-capsule-summary').waitFor();
    await seed(ext, { lexicon: { terms: [term('ELBO')], edges: [] } });
    await expect.poll(() => page.locator('.reader-capsule-message').innerText()).toBe('+5 XP');
    expectClean(ext);
    await page.close();
  });
});
