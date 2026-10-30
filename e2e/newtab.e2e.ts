import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Provocation } from '../src/shared/types';
import { NETWORK_NOISE, PAGES, expectA11y, expectClean, horizontalOverflow, launch, seed, type Ext } from './harness';
import { article, deck, feedItem, paper } from './seed';
import { html } from './sites';

const OFF = { ollamaUrl: 'http://127.0.0.1:9', layaUrl: '' }; // nothing listens on port 9

/** Every key the new tab lists from, empty: each test seeds over a clean slate. */
const EMPTY = { readingProgress: {}, papers: [], decks: [deck], cachedItems: [], readItems: [], provocations: [], annotations: [], focusSession: null, settings: OFF };

function question(i: number, paperId: string): Provocation {
  const at = Date.now() - i * 60_000;
  return {
    id: `q${i}`, docKey: 'k', paperId, page: 3, kind: 'equation', question: `Open question ${i}`, answer: '',
    status: i % 2 ? 'unsure' : 'open', annotationId: null, xp: 0, createdAt: at, updatedAt: at,
  };
}

describe('new tab: layout C (Now / Read)', () => {
  let ext: Ext;
  let first: string;
  let second: string;

  beforeAll(async () => {
    ext = await launch();
    first = `${ext.sites.origin('article')}/one`;
    second = `${ext.sites.origin('article')}/two`;
    ext.sites.setRoute('article', '/one', html('<h1>One</h1>'));
    ext.sites.setRoute('article', '/two', html('<h1>Two</h1>'));
  });
  afterAll(async () => ext.close());
  beforeEach(async () => {
    ext.errors.splice(0);
    await seed(ext, {
      ...EMPTY,
      readingProgress: {
        [first]: article(first, 'First story', { updatedAt: Date.now() - 60_000 }),
        [second]: article(second, 'Second story', { updatedAt: Date.now() - 120_000 }),
      },
    });
  });

  it('two columns: Now beside Read at 1280px', async () => {
    const page = await ext.page(PAGES.newtab);
    const now = await page.locator('.edition > .now-col').boundingBox();
    const read = await page.locator('.edition > .read-col').boundingBox();
    expect(now!.x + now!.width).toBeLessThanOrEqual(read!.x);
    expect(await page.locator('.now-col > .pomo').count()).toBe(1);
    expect(await page.locator('.now-col > section[aria-label="Brain dump"]').count()).toBe(1);
    expect(await page.locator('.now-col > .heat').count()).toBe(1);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('stacks under 720px: Now first, then Read, no sideways scroll', async () => {
    const page = await ext.page(PAGES.newtab);
    await page.setViewportSize({ width: 600, height: 900 });
    const now = await page.locator('.now-col').boundingBox();
    const read = await page.locator('.read-col').boundingBox();
    expect(read!.y).toBeGreaterThanOrEqual(now!.y + now!.height);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('empty profile: no empty sections, a hint where there is one, no errors', async () => {
    await seed(ext, EMPTY);
    const page = await ext.page(PAGES.newtab);
    await expect.poll(() => page.locator('section[aria-label="Continue"] .hint').count()).toBe(1);
    const empty = await page.locator('section').evaluateAll((sections) =>
      sections
        .filter((s) => !s.querySelector('[data-story]') && !s.querySelector('.hint') && s.closest('.read-col'))
        .map((s) => s.getAttribute('aria-label')),
    );
    expect(empty).toEqual([]);
    expect(await page.locator('section[aria-label="Deck"], section[aria-label="News"]').count()).toBe(0);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('crowded profile: five rows a list, "Show all N" discloses the rest, no inner scroll', async () => {
    const progress = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => {
        const url = `http://article.e2e.test/p${i}`;
        return [url, article(url, `Unfinished ${i}`, { updatedAt: Date.now() - i * 60_000 })];
      }),
    );
    await seed(ext, {
      ...EMPTY,
      readingProgress: progress,
      papers: [paper('1', 'A paper with questions', { id: 'p1', status: 'to-read' })],
      provocations: Array.from({ length: 60 }, (_, i) => question(i, 'p1')),
      cachedItems: Array.from({ length: 60 }, (_, i) => feedItem(`i${i}`, `Feed headline ${i}`)),
    });
    const page = await ext.page(PAGES.newtab);
    const reading = page.locator('section[aria-label="Continue reading"]');
    const deckList = page.locator('section[aria-label="Deck"]');
    const news = page.locator('section[aria-label="News"]');
    await expect.poll(() => news.locator('[data-story]').count()).toBe(5);
    expect(await reading.locator('[data-story]').count()).toBe(5);
    expect(await deckList.locator('[data-story]').count()).toBe(5);
    expect(await reading.locator('button.show-all').innerText()).toBe('Show all 60');
    expect(await deckList.locator('button.show-all').innerText()).toBe('Show all 60');
    expect(await news.locator('button.show-all').count()).toBe(0);
    // Deck rows say their status, newest first.
    expect(await deckList.locator('.row-state').first().innerText()).toBe('open');
    expect(await deckList.locator('.row-title').first().innerText()).toContain('Open question 0');

    await reading.locator('button.show-all').click();
    expect(await reading.locator('[data-story]').count()).toBe(60);
    await deckList.locator('button.show-all').click();
    expect(await deckList.locator('[data-story]').count()).toBe(60);

    const scrollers = await page.locator('.read-col, .read-col *').evaluateAll((els) =>
      els
        .filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight)
        .map((el) => el.className),
    );
    expect(scrollers).toEqual([]);
    await expectA11y(page, 'newtab');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectA11y(page, 'newtab');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('news is hidden during a focus round', async () => {
    await seed(ext, {
      cachedItems: [feedItem('a', 'A headline')],
      focusSession: { phase: 'focus', round: 1, phaseStartedAt: Date.now(), phaseEndsAt: Date.now() + 20 * 60_000, startedAt: Date.now(), focusMinutes: 25 },
    });
    const page = await ext.page(PAGES.newtab);
    await expect.poll(() => page.locator('.pomo-status').innerText()).toBe('focus · sites blocked');
    expect(await page.locator('section[aria-label="News"]').count()).toBe(0);
    await seed(ext, { focusSession: null });
    await expect.poll(() => page.locator('section[aria-label="News"]').count()).toBe(1);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('a Deck row opens the reader at its page', async () => {
    await seed(ext, {
      papers: [paper('1', 'A paper with questions', { id: 'p1', status: 'to-read' })],
      provocations: [question(0, 'p1')],
    });
    const page = await ext.page(PAGES.newtab);
    await page.locator('section[aria-label="Deck"] [data-story]').first().click();
    await page.waitForURL(/reader\/index\.html.*#page=3$/);
    await page.close();
  });

  it('keyboard: J moves to the second row, Enter opens it', async () => {
    const page = await ext.page(PAGES.newtab);
    const stories = page.locator('[data-story]');
    await expect.poll(() => stories.count()).toBe(2);
    await page.keyboard.press('j');
    expect(await stories.nth(1).evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter');
    await page.waitForURL(second);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('no motion: nothing animates after two idle seconds, the clock aside', async () => {
    const page = await ext.page(PAGES.newtab);
    await page.waitForTimeout(2000);
    const moving = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => !((a.effect as KeyframeEffect | null)?.target as Element | null)?.closest('.pomo'))
        .map((a) => ((a.effect as KeyframeEffect | null)?.target as Element | null)?.className ?? '?'),
    );
    expect(moving).toEqual([]);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
});
