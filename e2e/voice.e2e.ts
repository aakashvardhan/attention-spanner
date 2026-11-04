import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGES, expectA11y, expectClean, launch, mockClaude, mockGroq, seed, storage, type Ext } from './harness';
import { NETWORK_NOISE } from './noise';

// Chromium plays these WAVs as the microphone (e2e/fixtures; 16 kHz mono).
// speech.wav: 2 s room noise, ~3.5 s of `say` speech, 4 s noise. noise.wav: 6 s noise.
const FIXTURES = resolve(__dirname, 'fixtures');
/** Chrome logs every 4xx/5xx it is answered with; the error paths here cause them on purpose. */
const GROQ_ERRORS = [/^console: Failed to load resource: the server responded with a status of \d+ .*api\.groq\.com/];
const SAID = 'Um, I need to call the dentist tomorrow morning, and, uh, pay the rent.';
const CLEAN = 'I need to call the dentist tomorrow morning, and, pay the rent.';
/** 16 kHz × 16-bit: bytes of PCM per second. */
const BPS = 32_000;

/** The new tab's live Hacker News card, emptied: its links are not what these tests check. */
const quietFeed = (ext: Ext) =>
  ext.ctx.route('https://news.ycombinator.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/rss+xml', body: '<rss><channel></channel></rss>' }));

const box = (page: Page) => page.getByLabel('Empty your head here');
const talk = (page: Page) => page.getByRole('button', { name: 'Talk' });

describe('voice brain dump: speech', () => {
  let ext: Ext;

  beforeAll(async () => {
    ext = await launch({ fakeAudio: resolve(FIXTURES, 'speech.wav') });
    await quietFeed(ext);
  });
  afterAll(async () => ext?.close());

  it('without a Groq key, Talk says where to add one and records nothing', async () => {
    const calls = await mockGroq(ext, () => ({ status: 200, text: 'x' }));
    await seed(ext, { settings: { claudeKey: 'sk-e2e', groqKey: '' } });
    const page = await ext.page(PAGES.newtab);
    await talk(page).click();
    await expect.poll(() => page.getByRole('alert').innerText()).toContain('Add a Groq key in Settings');
    expect(calls).toHaveLength(0);
    await page.close();
    await ext.ctx.unroute('https://api.groq.com/**');
  });

  it('speech stops itself on the pause, only the speech is uploaded, and the cleaned words land at the cursor', async () => {
    const calls = await mockGroq(ext, () => ({ status: 200, text: SAID }));
    await seed(ext, { settings: { claudeKey: 'sk-e2e', groqKey: 'gsk-e2e' } });
    const page = await ext.page(PAGES.newtab);
    await box(page).fill('Already here.');
    await talk(page).click();
    await expect.poll(() => page.getByRole('button', { name: 'Stop' }).count()).toBe(1);
    await expect.poll(() => page.locator('.notebook-mic-status').innerText()).toMatch(/Listening|Hearing you/);
    // No click: the VAD ends it 2.5 s after the speech.
    await expect.poll(() => box(page).inputValue(), { timeout: 20_000 }).toBe(`Already here. ${CLEAN}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('whisper-large-v3-turbo');
    // ~8 s were recorded; the noise before and after the speech never left the device.
    expect(calls[0].wavBytes).toBeGreaterThan(2 * BPS);
    expect(calls[0].wavBytes).toBeLessThan(5.5 * BPS);
    await expect.poll(() => talk(page).count()).toBe(1);
    await expectA11y(page, 'newtab');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
    await ext.ctx.unroute('https://api.groq.com/**');
  });

  it('a rate limit keeps the clip: Retry resends the same audio without recording again', async () => {
    const replies = [{ status: 429 }, { status: 200, text: SAID }];
    const calls = await mockGroq(ext, () => replies.shift() ?? { status: 500 });
    await seed(ext, { settings: { claudeKey: 'sk-e2e', groqKey: 'gsk-e2e' } });
    const page = await ext.page(PAGES.newtab);
    await box(page).fill('');
    await talk(page).click();
    await expect.poll(() => page.getByRole('alert').innerText(), { timeout: 20_000 }).toContain('rate-limiting');
    expect(await box(page).inputValue()).toBe('');
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => box(page).inputValue()).toBe(CLEAN);
    expect(calls).toHaveLength(2);
    expect(calls[1].wavBytes).toBe(calls[0].wavBytes);
    await expect.poll(() => page.getByRole('button', { name: 'Retry' }).count()).toBe(0);
    expectClean(ext, [...NETWORK_NOISE, ...GROQ_ERRORS]);
    await page.close();
    await ext.ctx.unroute('https://api.groq.com/**');
  });

  it('a server error is retried once on its own; a bad key is not', async () => {
    const replies = [{ status: 503 }, { status: 200, text: 'Buy milk.' }, { status: 401 }];
    const calls = await mockGroq(ext, () => replies.shift() ?? { status: 500 });
    await seed(ext, { settings: { claudeKey: 'sk-e2e', groqKey: 'gsk-e2e' } });
    const page = await ext.page(PAGES.newtab);
    await talk(page).click();
    await expect.poll(() => box(page).inputValue(), { timeout: 20_000 }).toBe('Buy milk.');
    expect(calls).toHaveLength(2);

    await talk(page).click();
    await expect.poll(() => page.getByRole('alert').innerText(), { timeout: 20_000 }).toContain('Groq rejected the key');
    expect(calls).toHaveLength(3);
    expect(await box(page).inputValue()).toBe('Buy milk.');
    expectClean(ext, [...NETWORK_NOISE, ...GROQ_ERRORS]);
    await page.close();
    await ext.ctx.unroute('https://api.groq.com/**');
  });

  it('Esc while listening throws the take away: nothing is sent', async () => {
    const calls = await mockGroq(ext, () => ({ status: 200, text: 'should not appear' }));
    await seed(ext, { settings: { claudeKey: 'sk-e2e', groqKey: 'gsk-e2e' } });
    const page = await ext.page(PAGES.newtab);
    await box(page).fill('');
    await talk(page).click();
    await expect.poll(() => page.getByRole('button', { name: 'Stop' }).count()).toBe(1);
    await page.keyboard.press('Escape');
    await expect.poll(() => talk(page).count()).toBe(1);
    await page.waitForTimeout(9_000); // past where the VAD would have stopped it
    expect(calls).toHaveLength(0);
    expect(await box(page).inputValue()).toBe('');
    await page.close();
    await ext.ctx.unroute('https://api.groq.com/**');
  });

  it('a spoken dump goes through Cmd+Enter like a typed one: bullets plus top tasks', async () => {
    await mockGroq(ext, () => ({ status: 200, text: SAID }));
    await mockClaude(ext, () => 'Lighter:\n- The dentist and rent are on your mind.\n\nTop tasks:\n- | Call the dentist\n- | Pay the rent');
    await seed(ext, { settings: { claudeKey: 'sk-e2e', groqKey: 'gsk-e2e' }, todos: [], vault: null, lockedDumps: [], dumps: [] });
    const page = await ext.page(PAGES.newtab);
    await box(page).fill('');
    await talk(page).click();
    await expect.poll(() => box(page).inputValue(), { timeout: 20_000 }).toBe(CLEAN);
    await box(page).press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await expect.poll(() => page.locator('.notebook-bullets li').allInnerTexts()).toEqual(['The dentist and rent are on your mind.']);
    await expect.poll(async () => (await storage<{ text: string }[]>(ext, 'todos')).map((t) => t.text)).toEqual(['Call the dentist', 'Pay the rent']);
    await page.close();
    await ext.ctx.unroute('https://api.groq.com/**');
    await ext.ctx.unroute('https://api.anthropic.com/**');
  });
});

describe('voice brain dump: noise only', () => {
  let ext: Ext;

  beforeAll(async () => {
    ext = await launch({ fakeAudio: resolve(FIXTURES, 'noise.wav') });
    await quietFeed(ext);
  });
  afterAll(async () => ext?.close());

  it('a room with no one talking never reaches Groq', async () => {
    const calls = await mockGroq(ext, () => ({ status: 200, text: 'Thank you for watching!' }));
    await seed(ext, { settings: { claudeKey: 'sk-e2e', groqKey: 'gsk-e2e' } });
    const page = await ext.page(PAGES.newtab);
    await talk(page).click();
    await expect.poll(() => page.getByRole('button', { name: 'Stop' }).count()).toBe(1);
    await page.waitForTimeout(3_000);
    expect(await page.locator('.notebook-mic-status').innerText()).toContain('Listening');
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect.poll(() => page.getByRole('alert').innerText()).toContain("Didn't catch any speech");
    expect(calls).toHaveLength(0);
    expect(await box(page).inputValue()).toBe('');
    await page.close();
  });
});
