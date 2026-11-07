import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGES, expectA11y, launch, mockClaude, seed, storage, type Ext } from './harness';

/**
 * The side panel on YouTube: Gemini watches the video and writes takeaways
 * shaped to it (saved per video), timestamps seek the video, and Talk it
 * through thinks with Gemini. YouTube and Gemini are both scripted.
 */

const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';
const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`;

const TUTORIAL = {
  kind: 'tutorial',
  title: 'Flash an Ox64',
  summary: 'You end up with Linux booting on the board.',
  prerequisites: ['A USB serial adapter'],
  steps: [
    { t: '00:28', text: 'Install the flasher', code: 'pip install bflb-mcu-tool', gotcha: '' },
    { t: '01:15', text: 'Flash the image', code: '', gotcha: 'Hold the BOOT button while plugging in.' },
  ],
};
const LECTURE = {
  kind: 'lecture',
  title: 'Flash an Ox64',
  summary: 'A lecture summary.',
  cues: [{ t: '00:10', text: 'What is an MMU for?' }],
  notes: [{ t: '00:10', text: 'The MMU maps virtual to physical addresses.' }],
};

describe('side panel: YouTube', () => {
  let ext: Ext;
  /** Every Gemini request body, and how the next one is answered. */
  const gemini: { url: string; body: any }[] = [];
  let answer: (body: any) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
  let claudeCalls: unknown[] = [];

  async function openVideo(id: string): Promise<number> {
    const page = await ext.ctx.newPage();
    await page.goto(watch(id));
    return ext.sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id!, watch(id));
  }
  const videoPage = (id: string) => ext.ctx.pages().find((p) => p.url().includes(id))!;

  beforeAll(async () => {
    ext = await launch();
    claudeCalls = await mockClaude(ext, () => 'Haiku should not be asked here.');
    await ext.ctx.route('https://www.youtube.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body:
          '<!doctype html><html lang="en"><head><title>Ox64 setup - YouTube</title></head><body>' +
          '<div id="player"><video width="320" height="180"></video></div>' +
          "<script>window.go = (id) => history.pushState({}, '', '/watch?v=' + id);</script></body></html>",
      }),
    );
    await ext.ctx.route('https://generativelanguage.googleapis.com/**', async (route) => {
      const body = route.request().postDataJSON();
      gemini.push({ url: route.request().url(), body });
      const a = answer(body);
      await route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) });
    });
    await seed(ext, { settings: { claudeKey: 'sk-e2e', geminiKey: 'AIza-e2e' } });
  });
  afterAll(async () => ext?.close());

  const notesReply = (notes: object) => ({
    status: 200,
    body: { candidates: [{ content: { parts: [{ text: JSON.stringify(notes) }] } }] },
  });

  it('takes notes only when asked, from the watch URL, and keeps them', async () => {
    answer = () => notesReply(TUTORIAL);
    const tabId = await openVideo(A);
    const side = await ext.page(`${PAGES.sidebar}?tab=${tabId}`);
    await expect.poll(() => side.getByRole('button', { name: 'Take notes' }).count()).toBe(1);
    await side.waitForTimeout(500);
    expect(gemini.length).toBe(0);
    await side.getByRole('button', { name: 'Take notes' }).click();
    await expect.poll(() => side.getByText('Install the flasher').count(), { timeout: 10_000 }).toBe(1);
    expect(gemini.length).toBe(1);
    expect(gemini[0].url).toContain('models/gemini-3.6-flash:generateContent');
    expect(gemini[0].body.contents[0].parts[0].file_data.file_uri).toBe(watch(A));
    expect(await side.locator('pre code').first().innerText()).toBe('pip install bflb-mcu-tool');
    await expect.poll(() => side.getByText('Hold the BOOT button while plugging in.').count()).toBe(1);
    const saved = await storage<Record<string, { kind: string; title: string }>>(ext, 'videoNotes');
    expect(saved[A].kind).toBe('tutorial');
    await expectA11y(side, 'sidebar-video');
    await side.close();

    // Reopened: the notes are there, and Gemini is not asked again.
    const again = await ext.page(`${PAGES.sidebar}?tab=${tabId}`);
    await expect.poll(() => again.getByText('Install the flasher').count()).toBe(1);
    expect(gemini.length).toBe(1);

    // A timestamp seeks the video.
    await again.getByRole('button', { name: '1:15' }).click();
    await expect.poll(() => videoPage(A).evaluate(() => document.querySelector('video')!.currentTime)).toBe(75);

    // Another kind re-runs Gemini with that kind and replaces the notes.
    answer = () => notesReply(LECTURE);
    await again.getByRole('button', { name: 'Lecture' }).click();
    await expect.poll(() => again.getByText('What is an MMU for?').count(), { timeout: 10_000 }).toBe(1);
    expect(gemini.at(-1)!.body.contents[0].parts[1].text).toContain('as a lecture');
    expect((await storage<Record<string, { kind: string }>>(ext, 'videoNotes'))[A].kind).toBe('lecture');
    await again.close();
  });

  it('says what went wrong, and saves nothing', async () => {
    answer = () => ({ status: 400, body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } } });
    const tabId = await openVideo(B);
    const side = await ext.page(`${PAGES.sidebar}?tab=${tabId}`);
    await side.getByRole('button', { name: 'Take notes' }).click();
    await expect.poll(() => side.getByText("The Gemini key in Settings isn't valid.").count(), { timeout: 10_000 }).toBe(1);
    expect((await storage<Record<string, unknown>>(ext, 'videoNotes'))[B]).toBeUndefined();

    await seed(ext, { settings: { claudeKey: 'sk-e2e', geminiKey: '' } });
    const calls = gemini.length;
    await side.getByRole('button', { name: 'Take notes' }).click();
    await expect.poll(() => side.getByText('Taking notes needs a Gemini key in Settings.').count()).toBe(1);
    expect(gemini.length).toBe(calls);
    await seed(ext, { settings: { claudeKey: 'sk-e2e', geminiKey: 'AIza-e2e' } });
    await side.close();
  });

  it('talks it through with Gemini, from the notes and where the video is', async () => {
    answer = () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: 'What do you think the MMU buys you?' }] } }] } });
    const tabId = await openVideo(A);
    await videoPage(A).evaluate(() => { document.querySelector('video')!.currentTime = 42; });
    const side = await ext.page(`${PAGES.sidebar}?tab=${tabId}`);
    await side.getByRole('button', { name: 'Talk it through' }).click();
    await side.waitForTimeout(2_500);
    await side.locator('#talk-type').fill('It is about memory.');
    await side.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => side.getByText('What do you think the MMU buys you?').count(), { timeout: 10_000 }).toBeGreaterThan(0);
    const talk = gemini.at(-1)!.body;
    expect(talk.systemInstruction.parts[0].text).toContain('you never tell');
    expect(talk.systemInstruction.parts[0].text).toContain('watching the video');
    const text = talk.contents[0].parts[0].text;
    expect(text).toContain('They are at 0:42 in the video.');
    expect(text).toContain('The MMU maps virtual to physical addresses.');
    expect(claudeCalls.length).toBe(0);
    await side.close();
  });

  it('follows YouTube to the next video, and to a page that is not a video', async () => {
    const tabId = await openVideo(A);
    const side = await ext.page(`${PAGES.sidebar}?tab=${tabId}`);
    await expect.poll(() => side.getByText('What is an MMU for?').count()).toBe(1);
    await videoPage(A).evaluate((id) => (window as unknown as { go(id: string): void }).go(id), B);
    await expect.poll(() => side.getByRole('button', { name: 'Take notes' }).count(), { timeout: 5_000 }).toBe(1);
    await ext.sw.evaluate((id) => chrome.tabs.update(id, { url: 'https://www.youtube.com/feed/library' }), tabId);
    await expect.poll(() => side.getByRole('button', { name: 'Read the page' }).or(side.getByText("Couldn't find any text on this page.")).count(), { timeout: 8_000 }).toBe(1);
    await side.close();
  });
});
