import { createServer } from 'node:http';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VideoProgress } from '../src/shared/types';
import { PAGES, launch, seed, shot, storage, type Ext } from './harness';
import { article, deck, feedItem, paper } from './seed';
import { html, type Handler } from './sites';
import { normalizeUrl } from '../src/shared/urlNormalize';

const HOUR = 60 * 60_000;

function video(id: string, title: string, updatedAt: number): VideoProgress {
  return {
    kind: 'video',
    videoId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title,
    source: 'E2E Channel',
    maxPercent: 30,
    activeSeconds: 200,
    durationSeconds: 1200,
    positionSeconds: 360,
    firstOpenedAt: updatedAt - HOUR,
    updatedAt,
    completedAt: null,
  };
}

/** Ollama's health check and a /api/chat that answers every ask with one fixed summary. */
async function startChatMock() {
  const systems: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'mock' }] }));
      if (req.url === '/api/show') return res.end('{}');
      if (req.url === '/api/chat') {
        systems.push((JSON.parse(body) as { messages: { content: string }[] }).messages[0].content);
        res.setHeader('content-type', 'application/x-ndjson');
        return res.end(JSON.stringify({ message: { content: 'A talk about focus.\n- Point one\n- Point two' }, done: true }) + '\n');
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, systems, close: () => new Promise((r) => server.close(() => r(undefined))) };
}

/** A long, readable article. Numbered paragraphs: the extractor drops repeats. */
const longRead = (title: string): Handler => (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  const para = (i: number) => `<p>${i}. ${'The quick brown fox jumps over the lazy dog, and then it does so again. '.repeat(12)}</p>`;
  const body = Array.from({ length: 40 }, (_, i) => para(i + 1)).join('');
  res.end(`<!doctype html><html lang="en"><head><title>${title}</title></head><body><article><h1>${title}</h1>${body}</article></body></html>`);
};

/** The X on a row: its tools show when the row is hovered. */
async function remove(tab: Page, title: string) {
  await tab.locator('.row-wrap').filter({ has: tab.locator('.row-title').getByText(title, { exact: true }) }).hover();
  await tab.getByRole('button', { name: `Remove ${title} from Continue` }).click();
}

describe('continue: reading and watching', () => {
  let ext: Ext;
  let ollama: Awaited<ReturnType<typeof startChatMock>>;

  beforeAll(async () => {
    ext = await launch();
    ollama = await startChatMock();
  });
  afterAll(async () => {
    await ext?.close();
    await ollama?.close();
  });

  it('splits Continue into reading and watching, once each, and summarizes a video from its transcript', async () => {
    const now = Date.now();
    const page = 'https://blog.e2e.test/focus-workspace';
    await seed(ext, {
      settings: { ollamaUrl: ollama.url, ollamaChatModel: 'mock', layaUrl: '', cloudMode: 'off' },
      readingProgress: {
        'news.e2e.test/lead': article('https://news.e2e.test/lead', 'The lead story', { updatedAt: now - 1000 }),
        // Two feed links that led to the same page: one row, not two.
        'news.e2e.test/a': article(page, 'Focus workspace', { updatedAt: now - 2 * HOUR }),
        'other.e2e.test/a': article(page, 'Focus workspace', { updatedAt: now - 3 * HOUR }),
        'video:vid00000001': video('vid00000001', 'A talk about focus', now - 4 * HOUR),
        'video:vid00000002': video('vid00000002', 'Another talk', now - 5 * HOUR),
      },
    });
    // The transcript as the background caches it, so no YouTube fetch is needed.
    await ext.sw.evaluate(() =>
      chrome.storage.session.set({
        videoTranscripts: { vid00000001: [{ startSec: 0, endSec: 5, text: 'Today we talk about focus.' }] },
      }),
    );

    const tab = await ext.page(PAGES.newtab);
    const reading = tab.getByRole('region', { name: 'Continue reading' });
    const watching = tab.getByRole('region', { name: 'Continue watching' });
    await expect.poll(() => reading.locator('.row-title').allInnerTexts()).toEqual(['The lead story', 'Focus workspace']);
    expect(await watching.locator('.row-title').allInnerTexts()).toEqual(['A talk about focus', 'Another talk']);
    // One Continue label over both, and no video categories.
    expect(await tab.locator('section[aria-label="Continue"] > .label').innerText()).toBe('CONTINUE');

    // Summary covers the whole video, from its transcript.
    const row = watching.locator('li').first();
    await row.hover(); // the row's tools show when it is reached for
    await row.getByRole('button', { name: 'Summarize the whole video' }).click();
    await expect.poll(() => row.locator('.row-recap').innerText(), { timeout: 10_000 }).toContain('Point two');
    expect(ollama.systems.some((s) => s.includes('summarize a video from its transcript'))).toBe(true);
    await shot(tab, 'continue-groups');

    await row.getByRole('button', { name: 'Hide summary' }).click();
    await expect.poll(() => row.locator('.row-recap').count()).toBe(0);
  });

  it('cleans a video title, and says so when a video has no transcript to summarize', async () => {
    const now = Date.now();
    const settings = { ollamaUrl: ollama.url, ollamaChatModel: 'mock', layaUrl: '', cloudMode: 'off' };
    await seed(ext, {
      settings,
      readingProgress: {
        'news.e2e.test/lead': article('https://news.e2e.test/lead', 'The lead story', { updatedAt: now - 1000 }),
        // A video id YouTube doesn't know, so no transcript can be read for it.
        'video:zzzzzzzzzz1': {
          ...video('zzzzzzzzzz1', '(37) RL Course by David Silver - Lecture 1: Introduction to Reinforcement Learning', now - HOUR),
          source: 'Google DeepMind',
        },
        'video:vid00000002': video('vid00000002', 'Teaching a robot arm to pour', now - 2 * HOUR),
      },
    });
    const tab = await ext.page(PAGES.newtab);
    const watching = tab.getByRole('region', { name: 'Continue watching' });
    // YouTube's notification count is not part of the title.
    await expect.poll(() => watching.locator('.row-title').first().innerText()).toBe(
      'RL Course by David Silver - Lecture 1: Introduction to Reinforcement Learning',
    );

    // No transcript: the real reason, and the way past it.
    const row = watching.locator('li').first();
    await row.hover(); // the row's tools show when it is reached for
    await row.getByRole('button', { name: 'Summarize the whole video' }).click();
    await expect.poll(() => row.locator('.row-recap').innerText(), { timeout: 20_000 }).toContain('Open it in a tab and try again.');
    await tab.close();
  }, 60_000);

  it('the X takes a row off Continue: progress forgotten, a paper kept in its deck', async () => {
    const now = Date.now();
    const page = 'https://blog.e2e.test/focus-workspace';
    await seed(ext, {
      settings: { ollamaUrl: '', layaUrl: '', cloudMode: 'off' },
      decks: [deck],
      papers: [paper('1', 'A paper in progress', { lastReadAt: now - 6 * HOUR })],
      readingProgress: {
        'news.e2e.test/lead': article('https://news.e2e.test/lead', 'The lead story', { updatedAt: now - 1000 }),
        'news.e2e.test/a': article(page, 'Focus workspace', { updatedAt: now - 2 * HOUR }),
        'other.e2e.test/a': article(page, 'Focus workspace', { updatedAt: now - 3 * HOUR }),
        'video:vid00000001': video('vid00000001', 'A talk about focus', now - 4 * HOUR),
      },
    });
    const tab = await ext.page(PAGES.newtab);
    const reading = tab.getByRole('region', { name: 'Continue reading' });
    await expect.poll(() => reading.locator('.row-title').allInnerTexts()).toEqual(['The lead story', 'Focus workspace', 'A paper in progress']);

    // The merged duplicate goes with it: both stored copies are forgotten.
    await remove(tab, 'Focus workspace');
    await expect.poll(() => reading.locator('.row-title').allInnerTexts()).toEqual(['The lead story', 'A paper in progress']);
    expect(Object.keys(await storage<Record<string, unknown>>(ext, 'readingProgress')).sort()).toEqual([
      'news.e2e.test/lead',
      'video:vid00000001',
    ]);

    await remove(tab, 'A talk about focus');
    await expect.poll(() => tab.getByRole('region', { name: 'Continue watching' }).count()).toBe(0);

    // A paper leaves Continue but stays in its deck, to read, with its place kept.
    await remove(tab, 'A paper in progress');
    await expect.poll(() => reading.locator('.row-title').allInnerTexts()).toEqual(['The lead story']);
    const papers = await storage<{ id: string; status: string; progressPercent: number }[]>(ext, 'papers');
    expect(papers).toMatchObject([{ id: '1', status: 'to-read', progressPercent: 30 }]);

    // The last one goes, and Continue says how to fill it.
    await remove(tab, 'The lead story');
    await expect.poll(() => tab.getByRole('region', { name: 'Continue reading' }).count()).toBe(0);
    await expect.poll(() => tab.locator('section[aria-label="Continue"] .hint').innerText()).toContain('Nothing open');
  });

  it('shows a playing video as Watching on its Continue row, with no separate card', async () => {
    const now = Date.now();
    await seed(ext, {
      readingProgress: {
        'video:vid00000001': { ...video('vid00000001', 'A talk about focus', now), playing: true },
      },
    });
    const tab = await ext.page(PAGES.newtab);
    const row = tab.getByRole('region', { name: 'Continue watching' }).locator('.row');
    await expect.poll(() => row.locator('.row-state').innerText()).toBe('watching');
    expect(await row.locator('.row-meta').innerText()).toMatch(/^\d+:\d{2}$/);
    expect(await tab.locator('.now-watching').count()).toBe(0);
    await tab.close();
  });

  it('a tap on a row\'s metadata opens it and never hits its hidden X', async () => {
    const url = `${ext.sites.origin('article')}/kept`;
    ext.sites.setRoute('article', '/kept', html('<h1>Kept</h1>'));
    await seed(ext, { settings: { ollamaUrl: '', layaUrl: '', cloudMode: 'off' }, readingProgress: { [url]: article(url, 'Kept story') } });
    const tab = await ext.page(PAGES.newtab);
    await tab.mouse.move(0, 0);
    const meta = (await tab.locator('.row-meta').first().boundingBox())!;
    const tools = (await tab.locator('.row-tools').first().boundingBox())!;
    // Not hovered: the tools are invisible and take no clicks, and they never cover the metadata.
    expect(meta.x + meta.width).toBeLessThanOrEqual(tools.x);
    expect(
      await tab.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.row-tools') ?? null, [tools.x + tools.width - 8, tools.y + tools.height / 2]),
    ).toBeNull();
    await tab.mouse.click(meta.x + meta.width / 2, meta.y + meta.height / 2);
    await tab.waitForURL(url);
    expect(Object.keys(await storage<Record<string, unknown>>(ext, 'readingProgress'))).toEqual([url]);
    await tab.close();
  });

  it('a new page joins Continue only on topic, and "read this" always tracks', async () => {
    let gemini = 0;
    await ext.ctx.route('https://generativelanguage.googleapis.com/**', (route) => {
      gemini++;
      return route.abort();
    });
    const offTitle = 'Wasmer (YC S19) Is Hiring a Developer Advocate';
    const onTitle = 'A robot hand learns to grasp from play';
    const off = `${ext.sites.origin('jobs')}/hiring`;
    const on = `${ext.sites.origin('lab')}/grasp`;
    ext.sites.setRoute('jobs', '/hiring', longRead(offTitle));
    ext.sites.setRoute('lab', '/grasp', longRead(onTitle));
    // No Gemini key: the keywords decide.
    await seed(ext, {
      settings: { ollamaUrl: '', layaUrl: '', cloudMode: 'off', geminiTopicKey: '' },
      readingProgress: {},
      readItems: [],
      cachedItems: [
        feedItem('on', onTitle, { link: on, normalizedLink: normalizeUrl(on) }),
        feedItem('off', offTitle, { link: off, normalizedLink: normalizeUrl(off) }),
      ],
    });
    // Only these two: a page left over from an earlier test can still report late.
    const titles = async () =>
      Object.values(await storage<Record<string, { title: string }>>(ext, 'readingProgress'))
        .map((p) => p.title)
        .filter((t) => t === onTitle || t === offTitle)
        .sort();
    // A plain page reports every 5 s while visible; the reader reports on scroll.
    const read = async (tab: Page) => {
      await tab.waitForLoadState('domcontentloaded');
      await tab.mouse.move(640, 450);
      await tab.mouse.wheel(0, 800); // past the Continue threshold, short of finished
    };
    const readFromNews = async (title: string) => {
      const tab = await ext.page(PAGES.newtab);
      await tab.locator('section[aria-label="News"] [data-story]').filter({ hasText: title }).click();
      await tab.waitForURL((u) => !u.href.includes('newtab'));
      await read(tab);
      return tab;
    };

    // On topic: a row appears.
    const onTab = await readFromNews(onTitle);
    await expect.poll(titles, { timeout: 15_000 }).toEqual([onTitle]);
    await onTab.close();

    // Off topic: read just as long, past two report intervals, and never stored.
    const offTab = await readFromNews(offTitle);
    await offTab.waitForTimeout(11_000);
    expect(await titles()).toEqual([onTitle]);
    await offTab.close();

    // "Read this" on the same off-topic page: the user asked, so it is tracked.
    const home = await ext.page(PAGES.newtab);
    const opened = ext.ctx.waitForEvent('page');
    await home.evaluate((url) => chrome.runtime.sendMessage({ type: 'OPEN_ARTICLE', url, feedItemId: null }), off);
    const readThis = await opened;
    await read(readThis);
    await expect.poll(titles, { timeout: 15_000 }).toEqual([onTitle, offTitle].sort());
    await readThis.close();

    // Whether the read-this row shows here hangs on the close-time flush; the
    // next test checks that row on its own.
    await home.reload();
    await expect
      .poll(() => home.getByRole('region', { name: 'Continue reading' }).locator('.row-title').allInnerTexts())
      .toContain(onTitle);
    expect(gemini).toBe(0);
    await home.close();
  }, 60_000);

  it('"read this" on a long article lands in Continue, titled and unfinished', async () => {
    const title = 'A long read about reinforcement learning';
    const url = `${ext.sites.origin('longread')}/essay`;
    ext.sites.setRoute('longread', '/essay', longRead(title));
    await seed(ext, { settings: { ollamaUrl: '', layaUrl: '', cloudMode: 'off' }, readingProgress: {} });

    const home = await ext.page(PAGES.newtab);
    const opened = ext.ctx.waitForEvent('page');
    await home.evaluate(
      (url) => chrome.runtime.sendMessage({ type: 'OPEN_ARTICLE', url, feedItemId: null, readerView: true }),
      url,
    );
    const reader = await opened;
    await reader.locator('.article-block').first().waitFor();
    const entry = () =>
      storage<Record<string, { title: string; maxPercent: number; completedAt: number | null }>>(ext, 'readingProgress')
        .then((all) => all[normalizeUrl(url)]);
    // The first report lands on render, at the top: titled, not finished.
    await expect.poll(entry, { timeout: 10_000 }).toMatchObject({ title, completedAt: null, maxPercent: 0 });

    // Read a little, past the reader's 5 s report throttle.
    await reader.waitForTimeout(5_500);
    await reader.mouse.move(640, 450);
    await reader.mouse.wheel(0, 1600);
    await expect.poll(async () => (await entry())!.maxPercent, { timeout: 10_000 }).toBeGreaterThanOrEqual(5);
    const stored = (await entry())!;
    expect(stored.title).toBe(title);
    expect(stored.completedAt).toBeNull();
    expect(stored.maxPercent).toBeLessThan(90);
    await reader.close();

    await home.reload();
    await expect
      .poll(() => home.getByRole('region', { name: 'Continue reading' }).locator('.row-title').allInnerTexts())
      .toContain(title);
    await home.close();
  }, 30_000);
});
