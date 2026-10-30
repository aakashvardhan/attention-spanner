import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VideoProgress } from '../src/shared/types';
import { PAGES, launch, seed, shot, storage, type Ext } from './harness';
import { article, deck, paper } from './seed';

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
    nudge: { count: 0, lastAt: 0, dismissed: false },
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

  it('groups unfinished things by reading and watching, once each, and summarizes a video from its transcript', async () => {
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
    await expect.poll(() => reading.locator('.relay-row-title').allInnerTexts()).toEqual(['Focus workspace']);
    expect(await watching.locator('.relay-row-title').allInnerTexts()).toEqual(['A talk about focus', 'Another talk']);

    // Summary covers the whole video, from its transcript.
    const row = watching.locator('li').first();
    await row.getByRole('button', { name: 'Summarize the whole video' }).click();
    await expect.poll(() => row.locator('.relay-recap').innerText(), { timeout: 10_000 }).toContain('Point two');
    expect(ollama.systems.some((s) => s.includes('summarize a video from its transcript'))).toBe(true);
    await shot(tab, 'continue-groups');

    await row.getByRole('button', { name: 'Hide summary' }).click();
    await expect.poll(() => row.locator('.relay-recap').count()).toBe(0);
  });

  it('sorts videos by what they are, and says so when a video has no transcript to summarize', async () => {
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
    await expect.poll(() => watching.locator('.edition-also-category').allInnerTexts()).toEqual(['Lecture series', 'Robotics']);
    // YouTube's notification count is not part of the title.
    expect(await watching.locator('.relay-row-title').first().innerText()).toBe(
      'RL Course by David Silver - Lecture 1: Introduction to Reinforcement Learning',
    );

    // No transcript: the real reason, and the way past it.
    const row = watching.locator('li').first();
    await row.getByRole('button', { name: 'Summarize the whole video' }).click();
    await expect.poll(() => row.locator('.relay-recap').innerText(), { timeout: 20_000 }).toContain('Open it in a tab and try again.');
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
    await expect.poll(() => reading.locator('.relay-row-title').allInnerTexts()).toEqual(['Focus workspace', 'A paper in progress']);

    // The merged duplicate goes with it: both stored copies are forgotten.
    await tab.getByRole('button', { name: 'Remove Focus workspace from Continue' }).click();
    await expect.poll(() => reading.locator('.relay-row-title').allInnerTexts()).toEqual(['A paper in progress']);
    expect(Object.keys(await storage<Record<string, unknown>>(ext, 'readingProgress')).sort()).toEqual([
      'news.e2e.test/lead',
      'video:vid00000001',
    ]);

    await tab.getByRole('button', { name: 'Remove A talk about focus from Continue' }).click();
    await expect.poll(() => tab.getByRole('region', { name: 'Continue watching' }).count()).toBe(0);

    // A paper leaves Continue but stays in its deck, to read, with its place kept.
    await tab.getByRole('button', { name: 'Remove A paper in progress from Continue' }).click();
    await expect.poll(() => tab.getByRole('region', { name: 'Continue reading' }).count()).toBe(0);
    const papers = await storage<{ id: string; status: string; progressPercent: number }[]>(ext, 'papers');
    expect(papers).toMatchObject([{ id: '1', status: 'to-read', progressPercent: 30 }]);

    // The lead story has an X too.
    await tab.getByRole('button', { name: 'Remove The lead story from Continue' }).click();
    await expect.poll(() => tab.locator('.edition-notice').innerText()).toContain('Nothing open');
  });

  it('shows a playing video as Watching on its Continue row, with no separate card', async () => {
    const now = Date.now();
    await seed(ext, {
      readingProgress: {
        'video:vid00000001': { ...video('vid00000001', 'A talk about focus', now), playing: true },
      },
    });
    const tab = await ext.page(PAGES.newtab);
    await expect.poll(() => tab.locator('.edition-lead-list').innerText()).toMatch(/Watching · \d+:\d{2}/);
    expect(await tab.locator('.now-watching, .relay-watching-card').count()).toBe(0);
    await tab.close();
  });
});
