import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGES, expectClean, launch, mockClaude, seed, shot, storage, type Ext, clearCaches } from './harness';
import { makePdf } from './seed';

/**
 * "Talk it through" in the reader, against scripted Groq and Claude: Haiku
 * opens, Orpheus speaks it in TTS-sized chunks, the fake mic's speech becomes
 * a turn, and that turn reaches Haiku. Checks the wiring, not the voices.
 */

const FIXTURES = resolve(__dirname, 'fixtures');
const ASKED = 'Hm, okay. What problem does it solve? Say it in a line.';
const HEARD = 'It speeds up attention.';

/** 0.2 s of silence, 24 kHz mono 16-bit: what the speech mock answers. */
function silentWav(): Buffer {
  const pcm = 24_000 * 0.2 * 2;
  const b = Buffer.alloc(44 + pcm);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + pcm, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24_000, 24);
  b.writeUInt32LE(48_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(pcm, 40);
  return b;
}

describe('reader: talk it through', () => {
  let ext: Ext;
  let pdfUrl = '';
  const spoken: { model: string; voice: string; input: string }[] = [];
  let transcribed = 0;
  let prompts: { system: string; prompt: string }[] = [];
  /** While set, speech requests hang: the agent stays mid-reply. */
  let holdSpeech = false;

  beforeAll(async () => {
    ext = await launch({ fakeAudio: resolve(FIXTURES, 'speech.wav') });
    const pdf = makePdf(2);
    ext.sites.setRoute('papers', '/talk.pdf', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(pdf);
    });
    pdfUrl = `${ext.sites.origin('papers')}/talk.pdf`;
    prompts = await mockClaude(ext, () => ASKED);
    const wav = silentWav();
    await ext.ctx.route('https://api.groq.com/**', async (route) => {
      if (route.request().url().endsWith('/audio/speech')) {
        spoken.push(route.request().postDataJSON());
        while (holdSpeech) await new Promise((r) => setTimeout(r, 100));
        await route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav' }, body: wav });
      } else {
        transcribed++;
        await route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: HEARD }) });
      }
    });
  });
  afterAll(async () => ext?.close());

  const openPanel = async (): Promise<Page> => {
    const page = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(pdfUrl)}`);
    await page.waitForSelector('[aria-label^="Page 1 of"] .textLayer span');
    await clearCaches(page);
    await page.mouse.move(400, 10);
    await page.getByRole('button', { name: 'Talk it through' }).click();
    await expect.poll(() => page.getByRole('heading', { name: 'Talk it through' }).count()).toBe(1);
    return page;
  };

  it('without keys, says what it needs and calls nothing', async () => {
    await seed(ext, { settings: { claudeKey: '', groqKey: '' } });
    const page = await openPanel();
    await page.getByRole('button', { name: 'Start talking' }).click();
    await expect.poll(() => page.getByRole('alert').innerText()).toContain('needs a Claude key and a Groq key');
    expect(spoken).toHaveLength(0);
    expect(prompts).toHaveLength(0);
    await page.close();
  });

  it('opens the conversation aloud, hears the reader, and answers the turn', async () => {
    await seed(ext, { settings: { claudeKey: 'sk-e2e', groqKey: 'gsk-e2e' } });
    const page = await openPanel();
    await page.getByRole('button', { name: 'Start talking' }).click();

    const turns = page.locator('.reader-talk-turns li');
    await expect.poll(() => turns.first().innerText()).toContain('It asked');
    await expect.poll(() => spoken.length).toBeGreaterThanOrEqual(1);
    // A short reply is one request (one intonation), never over the 200-char cap.
    expect(spoken[0].input).toBe(ASKED);
    expect(spoken.every((s) => s.model === 'canopylabs/orpheus-v1-english' && s.voice === 'autumn' && s.input.length <= 200)).toBe(true);
    expect(prompts[0].system).toContain('never tell');

    // The fake mic's speech ends a turn, Whisper hears it, Haiku gets it.
    await expect.poll(() => page.locator('[data-who="you"]').count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    expect(transcribed).toBeGreaterThanOrEqual(1);
    await expect.poll(() => prompts.some((p) => p.prompt.includes(`Them: ${HEARD}`)), { timeout: 10_000 }).toBe(true);

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect.poll(() => page.getByRole('button', { name: 'Start talking' }).count()).toBe(1);
    await page.close();
    expectClean(ext);
  });

  it('keeps the mic off while it replies, so its own voice and the room never cut it off; Cut in does', async () => {
    await seed(ext, { settings: { claudeKey: 'sk-e2e', groqKey: 'gsk-e2e', talkVoice: 'autumn' } });
    const page = await openPanel();
    holdSpeech = true;
    const heardBefore = transcribed;
    await page.getByRole('button', { name: 'Start talking' }).click();
    // The fake mic plays speech from 2 s in; the agent is mid-reply the whole time.
    await page.waitForTimeout(7_000);
    expect(transcribed).toBe(heardBefore);
    expect(await page.locator('[data-who="agent"]').first().innerText()).toContain('What problem does it solve?');
    await page.getByRole('button', { name: 'Cut in' }).click();
    holdSpeech = false;
    await expect.poll(() => page.locator('[data-phase]').getAttribute('data-phase')).toBe('listening');
    await expect.poll(() => transcribed, { timeout: 20_000 }).toBeGreaterThan(heardBefore);
    await page.getByRole('button', { name: 'Stop' }).click();
    await page.close();
  });

  it('takes a typed turn instead of a spoken one: it replies aloud and never opens the mic', async () => {
    await seed(ext, { settings: { claudeKey: 'sk-e2e', groqKey: 'gsk-e2e' } });
    const page = await openPanel();
    const [heardBefore, spokenBefore, askedBefore] = [transcribed, spoken.length, prompts.length];
    const box = page.getByLabel('Or type it');
    expect(await page.getByRole('button', { name: 'Send' }).isDisabled()).toBe(true);
    await box.fill('It replaces recurrence with attention.');
    await box.press('Enter');
    expect(await box.inputValue()).toBe('');
    await expect.poll(() => page.locator('[data-who="you"]').first().innerText()).toContain('It replaces recurrence with attention.');
    await expect.poll(() => prompts.length).toBe(askedBefore + 1);
    expect(prompts.at(-1)!.prompt).toContain('Them: It replaces recurrence with attention.');
    // The socratic-tutor method: diagnostic first, explain only on "just tell me" or repeated misses.
    expect(prompts.at(-1)!.system).toContain('Socratic tutor');
    expect(prompts.at(-1)!.system).toContain('teach nothing until you know');
    expect(prompts.at(-1)!.system).toContain('Just tell me');
    await expect.poll(() => page.locator('[data-who="agent"]').first().innerText()).toContain('What problem does it solve?');
    await expect.poll(() => spoken.length).toBeGreaterThan(spokenBefore);
    // Begun by typing: when the reply has played it waits for more typing, mic off.
    await expect.poll(() => page.locator('[data-phase]').getAttribute('data-phase'), { timeout: 10_000 }).toBe('off');
    await page.waitForTimeout(3_000);
    expect(transcribed).toBe(heardBefore);
    await page.close();
    expectClean(ext);
  });

  it('with only a Claude key, a typed turn gets a written reply and nothing is spoken', async () => {
    await seed(ext, { settings: { claudeKey: 'sk-e2e', groqKey: '', openaiKey: '' } });
    const page = await openPanel();
    const spokenBefore = spoken.length;
    await page.getByLabel('Or type it').fill('It speeds up attention.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => page.locator('[data-who="agent"]').first().innerText()).toContain('What problem does it solve?');
    await expect.poll(() => page.locator('[data-phase]').getAttribute('data-phase')).toBe('off');
    expect(spoken.length).toBe(spokenBefore);
    expect(await page.getByRole('alert').count()).toBe(0);
    await shot(page, 'talk-typed');
    await page.close();
    expectClean(ext);
  });

  it('Settings picks the voice, previews it, and the reader speaks in it', async () => {
    await seed(ext, { settings: { claudeKey: 'sk-e2e', groqKey: 'gsk-e2e' } });
    const opts = await ext.page(PAGES.options);
    await opts.getByLabel(/^Voice/).selectOption('troy');
    await expect.poll(async () => (await storage<{ talkVoice: string }>(ext, 'settings')).talkVoice).toBe('troy');
    const before = spoken.length;
    await opts.getByRole('button', { name: 'Hear it' }).click();
    await expect.poll(() => spoken.length).toBe(before + 1);
    expect(spoken.at(-1)?.voice).toBe('troy');
    await opts.close();

    const page = await openPanel();
    const at = spoken.length;
    await page.getByRole('button', { name: 'Start talking' }).click();
    await expect.poll(() => spoken.length).toBeGreaterThan(at);
    expect(spoken.slice(at).every((s) => s.voice === 'troy')).toBe(true);
    await page.getByRole('button', { name: 'Stop' }).click();
    await page.close();
    expectClean(ext);
  });
});
