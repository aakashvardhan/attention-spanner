import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGES, expectClean, launch, mockClaude, seed, type Ext, clearCaches } from './harness';
import { makePdf, toneWav } from './seed';

/**
 * Listen: the paper read aloud as narration, against scripted Haiku and
 * Orpheus. Checks the wiring: page by page from where you are, each page
 * narrated with the last one's ending, reference pages skipped, the voice
 * carrying the narration (not the raw page), pause and resume, and no
 * reader question interrupting it.
 */

const NARRATION: Record<number, string> = {
  1: 'Section one: Introduction. This is the training loss: for every token, it takes the log of the probability the model gave the right word.',
  2: '[SKIP]',
  3: 'And that is how the model is evaluated on the held out set.',
};

describe('reader: listen', () => {
  let ext: Ext;
  let pdfUrl = '';
  const spoken: string[] = [];
  /** How Groq answers the next speech request; 200 with a tone unless a test says otherwise. */
  let groq: (input: string) => { status: number; headers?: Record<string, string>; body?: string } | null = () => null;
  let prompts: { system: string; prompt: string; images: number }[] = [];
  /** Speech that went to OpenAI (the fallback), with what was asked of it. */
  const openai: { model: string; voice: string; input: string; instructions: string }[] = [];

  beforeAll(async () => {
    ext = await launch();
    const pdf = makePdf(3, true);
    ext.sites.setRoute('papers', '/listen.pdf', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(pdf);
    });
    pdfUrl = `${ext.sites.origin('papers')}/listen.pdf`;
    prompts = await mockClaude(ext, (_system, prompt) => NARRATION[Number(/page (\d+) of/.exec(prompt)?.[1])] ?? 'Unexpected.');
    const wav = toneWav();
    await ext.ctx.route('https://api.groq.com/**', async (route) => {
      const input: string = route.request().postDataJSON().input;
      const refuse = groq(input);
      if (refuse) {
        await route.fulfill({ status: refuse.status, headers: { 'content-type': 'application/json', ...refuse.headers }, body: refuse.body ?? '{}' });
        return;
      }
      spoken.push(input);
      await route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav' }, body: wav });
    });
    await ext.ctx.route('https://api.openai.com/**', async (route) => {
      openai.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav' }, body: wav });
    });
    await seed(ext, { settings: { claudeKey: 'sk-e2e', groqKey: 'gsk-e2e' } });
  });
  afterAll(async () => ext?.close());

  it('narrates page by page, skips the references page, pauses and resumes, and never asks a question meanwhile', async () => {
    const page = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(pdfUrl)}`);
    await page.waitForSelector('[aria-label^="Page 1 of"] .textLayer span');
    await clearCaches(page);
    await page.mouse.move(400, 10);
    await page.getByRole('button', { name: 'Listen' }).click();
    await page.getByRole('button', { name: 'Read from page 1' }).click();

    const status = page.locator('#listen-heading + [role="status"]');
    await expect.poll(() => status.innerText()).toBe('Reading page 1');
    await expect.poll(() => page.locator('.reader-talk-turns').innerText()).toContain('This is the training loss');
    // The sentence being spoken is marked in the narration.
    await expect.poll(() => page.locator('.reader-talk-turns mark.listen-now').count()).toBe(1);

    await page.getByRole('button', { name: 'Pause' }).click();
    await expect.poll(() => status.innerText()).toMatch(/^Paused on page \d$/);
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect.poll(() => status.innerText()).toMatch(/^Reading page \d$/);

    await expect.poll(() => status.innerText(), { timeout: 30_000 }).toBe("That's the end of the paper.");

    // Haiku narrated each page; the second was told how the first ended.
    const asked = prompts.map((p) => /page (\d) of 3/.exec(p.prompt)?.[1]);
    expect(asked).toEqual(['1', '2', '3']);
    expect(prompts[0].prompt).toContain('where the listener starts');
    expect(prompts[1].prompt).toContain('The previous page ended');
    expect(prompts[0].system).toContain('Never read math symbol by symbol');
    // Each page went to Haiku as a picture too, so the math is read as printed.
    expect(prompts.every((p) => p.images === 1)).toBe(true);
    // The voice speaks the narration, never the [SKIP] page or the raw PDF text.
    expect(spoken.join(' ')).toBe(`${NARRATION[1]} ${NARRATION[3]}`);
    expect(spoken.every((s) => s.length <= 200)).toBe(true);
    // It turned the pages as it read; turning them is not finishing a section.
    await expect.poll(() => page.locator('.reader-capsule').innerText()).toContain('p. 3 of 3');
    expect(await page.locator('.reader-question').count()).toBe(0);
    await page.close();
    expectClean(ext);
  });

  const openListen = async () => {
    const page = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(pdfUrl)}`);
    await page.waitForSelector('[aria-label^="Page 1 of"] .textLayer span');
    await clearCaches(page);
    await page.mouse.move(400, 10);
    await page.getByRole('button', { name: 'Listen' }).click();
    return page;
  };
  /** Chrome logs the 429s these tests answer with on purpose. */
  const GROQ_429 = [/^console: Failed to load resource: the server responded with a status of 429 .*api\.groq\.com/];

  it('keeps the spoken sentence in view as it reads', async () => {
    const page = await openListen();
    // A short panel, so the narration starts below its fold.
    await page.locator('.reader-talk').evaluate((el) => {
      (el as HTMLElement).style.height = '180px';
    });
    await page.getByRole('button', { name: 'Read from page 1' }).click();
    const inView = () =>
      page.evaluate(() => {
        const panel = document.querySelector('.reader-talk');
        const bar = document.querySelector('.listen-controls');
        const mark = document.querySelector('.reader-talk-turns mark.listen-now');
        if (!panel || !bar || !mark) return false;
        const [p, c, m] = [panel.getBoundingClientRect(), bar.getBoundingClientRect(), mark.getBoundingClientRect()];
        // Scrolled, the controls still pinned at the top, the sentence visible below them.
        return panel.scrollTop > 0 && Math.abs(c.top - p.top) < 2 && m.top >= c.bottom && m.bottom <= p.bottom;
      });
    try {
      await expect.poll(inView, { timeout: 10_000 }).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('a paper heard once is heard again without asking Haiku or Groq', async () => {
    const page = await openListen();
    try {
      // Stay on page 1, so both runs start from the same place.
      await page.getByLabel('Turn pages as it reads').uncheck();
      const status = page.locator('#listen-heading + [role="status"]');
      const read = async () => {
        await page.getByRole('button', { name: 'Read from page 1' }).click();
        await expect.poll(() => status.innerText(), { timeout: 20_000 }).toBe("That's the end of the paper.");
      };
      const [asked, said] = [prompts.length, spoken.length];
      await read();
      // Three pages narrated (one of them [SKIP]); two spoken.
      expect([prompts.length - asked, spoken.length - said]).toEqual([3, 2]);
      // Again: the narrations and their audio come from the cache.
      await read();
      expect([prompts.length - asked, spoken.length - said]).toEqual([3, 2]);
    } finally {
      await page.close();
    }
  });

  it('sits beside the page, not over it', async () => {
    const page = await openListen();
    const panel = await page.locator('.reader-talk').boundingBox();
    await expect
      .poll(async () => {
        const pages = await page.locator('.reader-page').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
        return Math.max(...pages);
      })
      .toBeLessThanOrEqual(panel!.x);
    await page.close();
  });

  it("waits out Groq's per-minute limit and sends the same words again, so nothing is skipped", async () => {
    spoken.length = 0;
    const refused = new Set<string>();
    groq = (input) => {
      if (refused.has(input)) return null;
      refused.add(input);
      return { status: 429, headers: { 'retry-after': '1' }, body: '{"error":{"message":"Rate limit reached on requests per minute (RPM)"}}' };
    };
    const page = await openListen();
    await page.getByRole('button', { name: 'Read from page 1' }).click();
    await expect.poll(() => page.getByText(/per-minute limit: carrying on in 1 s/).count()).toBe(1);
    const status = page.locator('#listen-heading + [role="status"]');
    await expect.poll(() => status.innerText(), { timeout: 30_000 }).toBe("That's the end of the paper.");
    expect(spoken.join(' ')).toBe(`${NARRATION[1]} ${NARRATION[3]}`);
    expect(await page.getByRole('alert').count()).toBe(0);
    await page.close();
    groq = () => null;
    expectClean(ext, GROQ_429);
  });

  it("switches to OpenAI's voice at Groq's daily limit, resends the refused words, and stays there", async () => {
    spoken.length = 0;
    openai.length = 0;
    await seed(ext, { settings: { claudeKey: 'sk-e2e', groqKey: 'gsk-e2e', openaiKey: 'sk-openai-e2e' } });
    let groqCalls = 0;
    groq = () => {
      groqCalls++;
      return { status: 429, body: '{"error":{"message":"Rate limit reached on requests per day (RPD): Limit 100, Used 100"}}' };
    };
    const page = await openListen();
    await page.getByRole('button', { name: 'Read from page 1' }).click();
    await expect.poll(() => page.getByText(/Switched to OpenAI's voice: Groq's daily speech limit/).count()).toBe(1);
    const status = page.locator('#listen-heading + [role="status"]');
    await expect.poll(() => status.innerText(), { timeout: 30_000 }).toBe("That's the end of the paper.");
    // Groq was asked once; everything, including the refused chunk, went to OpenAI.
    expect(groqCalls).toBe(1);
    expect(spoken).toHaveLength(0);
    expect(openai.map((o) => o.input).join(' ')).toBe(`${NARRATION[1]} ${NARRATION[3]}`);
    expect(openai.every((o) => o.model === 'gpt-4o-mini-tts' && o.voice === 'marin' && o.instructions.includes('friend'))).toBe(true);
    expect(await page.getByRole('alert').count()).toBe(0);
    await page.close();
    groq = () => null;
    await seed(ext, { settings: { claudeKey: 'sk-e2e', groqKey: 'gsk-e2e', openaiKey: '' } });
    expectClean(ext, GROQ_429);
  });

  it("stops at Groq's daily limit and says so", async () => {
    const before = prompts.length;
    groq = () => ({ status: 429, headers: { 'retry-after': '2' }, body: '{"error":{"message":"Rate limit reached on tokens per day (TPD): Limit 3600, Used 3600"}}' });
    const page = await openListen();
    await page.getByRole('button', { name: 'Read from page 1' }).click();
    await expect.poll(() => page.getByRole('alert').innerText()).toContain('daily speech limit');
    await expect.poll(() => page.getByRole('button', { name: 'Read from page 1' }).count(), { timeout: 15_000 }).toBe(1);
    // It stopped preparing pages once Groq said no.
    expect(prompts.length - before).toBeLessThanOrEqual(2);
    await page.close();
    groq = () => null;
    expectClean(ext, GROQ_429);
  });
});
