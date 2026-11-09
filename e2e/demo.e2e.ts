import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import type { Locator, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { OUT, PAGES, launch, mockClaude, seed } from './harness';
import { bigLexicon } from './lexiconSeed';
import { folder, paper } from './seed';
import TS_VAULT from './fixtures/ts-vault.json';

/** Today at `hour`:00, local: as epoch ms, and as the brain dump writes it. */
const at = (hour: number) => {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d;
};
const todayMs = (hour: number) => at(hour).getTime();
const today = (hour: number) => {
  const d = at(hour);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(hour)}:00`;
};

/**
 * A screen-recorded walkthrough for sharing, not a test: skipped unless DEMO=1.
 *   set -a; . ~/.config/reader-demo.env; set +a   # GROQ_API_KEY, OPENAI_API_KEY
 *   DEMO=1 DEMO_PDF=/path/to/1706.03762.pdf npx vitest run e2e/demo.e2e.ts --config vitest.e2e.config.ts
 * Writes e2e/out/demo.mp4, with the sound the page actually played.
 * Haiku is scripted so every take is the same; the voices are live. Speech
 * goes to OpenAI (the extension's own fallback request), since Groq Orpheus
 * allows 3,600 tokens a day; Whisper stays on Groq. "You" are an OpenAI
 * voice too, played into the fake mic.
 */
const ARXIV = '1706.03762';
const done = { id: '01985f0e-9788-7924-8401-000000000003', name: 'Completed', type: 'default-completed' };

/** Playwright's video has no cursor: draw one that follows the mouse and pulses on click. */
const CURSOR = `addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(255,80,60,.55);border:2px solid #fff;box-shadow:0 0 6px rgba(0,0,0,.5);transition:transform .12s;left:-50px;top:-50px';
  document.documentElement.appendChild(c);
  addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => (c.style.transform = 'scale(.6)'), true);
  addEventListener('mouseup', () => (c.style.transform = ''), true);
});`;

/**
 * The page's sound, for the soundtrack: every buffer it plays (when it
 * starts, and when it is cut off) and every time it opens the mic.
 */
const AUDIO_TAP = `(() => {
  const send = (e) => window.__demoAudio?.(e);
  let n = 0;
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0) {
    const b = this.buffer;
    if (b) {
      this.__id = ++n;
      const ch = b.getChannelData(0);
      const pcm = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) pcm[i] = Math.max(-1, Math.min(1, ch[i])) * 32767;
      const u8 = new Uint8Array(pcm.buffer);
      let bin = '';
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      send({ kind: 'play', id: this.__id, at: Date.now() + Math.max(0, when - this.context.currentTime) * 1000, rate: b.sampleRate, pcm: btoa(bin) });
    }
    return start.apply(this, arguments);
  };
  const stop = AudioScheduledSourceNode.prototype.stop;
  AudioScheduledSourceNode.prototype.stop = function () {
    if (this.__id) send({ kind: 'stop', id: this.__id, at: Date.now() });
    return stop.apply(this, arguments);
  };
  const gum = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = async function (c) {
    const stream = await gum.call(this, c);
    const id = ++n;
    send({ kind: 'mic', id, at: Date.now() });
    for (const t of stream.getTracks()) {
      const end = t.stop;
      t.stop = function () { send({ kind: 'stop', id, at: Date.now() }); return end.call(this); };
    }
    return stream;
  };
})();`;

type Sound = { kind: 'play' | 'mic' | 'stop'; id: number; at: number; rate?: number; pcm?: string };

function wav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const OPENAI_INSTRUCTIONS =
  'Speak like a calm, curious friend explaining a research paper out loud: warm, unhurried, natural pauses between ideas, never a newsreader.';

async function openaiSpeech(input: string, voice: string, instructions: string): Promise<Buffer> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input, instructions, response_format: 'wav' }),
  });
  if (!res.ok) throw new Error(`OpenAI speech ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

const SAID = 'I think it is about getting rid of recurrence. RNNs read one word at a time, so training is really slow.';

/** "You", spoken into the fake mic: a pause, the sentence, then quiet (the file loops). */
async function youWav(): Promise<string> {
  const out = join(OUT, 'demo-you.wav');
  if (existsSync(out)) return out;
  mkdirSync(OUT, { recursive: true });
  const raw = join(OUT, 'demo-you-raw.wav');
  writeFileSync(raw, await openaiSpeech(SAID, 'ash', 'A grad student thinking out loud to a friend: casual, a little tentative, natural.'));
  execFileSync(ffmpeg!, ['-v', 'error', '-y', '-f', 'lavfi', '-t', '1.2', '-i', 'anullsrc=r=48000:cl=mono', '-i', raw, '-f', 'lavfi', '-t', '10', '-i', 'anullsrc=r=48000:cl=mono',
    '-filter_complex', '[1]aresample=48000,aformat=channel_layouts=mono[s];[0][s][2]concat=n=3:v=0:a=1', '-c:a', 'pcm_s16le', out]);
  return out;
}

/** The frames as video, every sound laid where it played, as one mp4. */
function mux(dir: string, t0: number, sounds: Sound[], you: string, out: string) {
  const stops = new Map(sounds.filter((s) => s.kind === 'stop').map((s) => [s.id, s.at]));
  const clips: { file: string; at: number; until?: number }[] = [];
  for (const s of sounds) {
    if (s.kind === 'play') {
      const file = join(dir, `sound-${s.id}.wav`);
      writeFileSync(file, wav(Buffer.from(s.pcm!, 'base64'), s.rate!));
      clips.push({ file, at: s.at, until: stops.get(s.id) });
    } else if (s.kind === 'mic') clips.push({ file: you, at: s.at, until: stops.get(s.id) });
  }
  // The mix goes to a WAV first: AAC straight out of amix trips over frame sizes.
  const mixed = join(dir, 'mix.wav');
  if (clips.length) {
    const audio = ['-v', 'error', '-y'];
    for (const c of clips) audio.push('-i', c.file);
    const chains = clips.map((c, i) => {
      const trim = c.until && c.until > c.at ? `atrim=0:${((c.until - c.at) / 1000).toFixed(3)},` : '';
      return `[${i}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,${trim}adelay=delays=${Math.round(Math.max(0, c.at - t0))}:all=1[a${i}]`;
    });
    audio.push('-filter_complex', `${chains.join(';')};${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0:duration=longest[a]`, '-map', '[a]', '-c:a', 'pcm_s16le', mixed);
    execFileSync(ffmpeg!, audio);
  }
  const args = ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt')];
  if (clips.length) args.push('-i', mixed, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '160k');
  args.push('-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', out);
  execFileSync(ffmpeg!, args);
  return clips.length;
}

/**
 * Playwright's recordVideo (screencast) comes out blank on extension pages,
 * while screenshots don't: capture JPEGs back to back and keep their times.
 */
function record(first: Page, dir: string) {
  let page = first;
  const sessions = new Map<Page, Promise<import('playwright').CDPSession>>();
  const session = (p: Page) => {
    if (!sessions.has(p)) sessions.set(p, p.context().newCDPSession(p));
    return sessions.get(p)!;
  };
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames: { file: string; at: number }[] = [];
  let on = true;
  let held: Promise<void> | null = null;
  const hold = async <T>(change: () => Promise<T>) => {
    let release!: () => void;
    held = new Promise((r) => (release = r));
    await new Promise((r) => setTimeout(r, 120));
    try {
      return await change();
    } finally {
      held = null;
      release();
    }
  };
  const loop = (async () => {
    while (on) {
      if (held) await held;
      const t = Date.now();
      const cdp = await session(page);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 88, optimizeForSpeed: true }).catch(() => ({ data: '' }));
      if (data) {
        const file = `f${String(frames.length).padStart(5, '0')}.jpg`;
        writeFileSync(join(dir, file), Buffer.from(data, 'base64'));
        frames.push({ file, at: t });
      }
      // ~25 fps is plenty, and leaves the page room to run.
      await new Promise((r) => setTimeout(r, Math.max(0, 40 - (Date.now() - t))));
    }
  })();
  return {
    /** A capture in flight across a navigation never returns: hold the camera while the page changes. */
    go: (url: string, p: Page = page) => hold(() => p.goto(url).catch(() => null)),
    /** Film another tab from now on. */
    watch: (p: Page) => hold(async () => void (page = p)),
    async stop() {
      on = false;
      held = null;
      await loop;
      const lines = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.at ?? f.at + 100) - f.at) / 1000}`);
      writeFileSync(join(dir, 'frames.txt'), `${lines.join('\n')}\nfile '${frames.at(-1)!.file}'\n`);
      return { count: frames.length, t0: frames[0].at };
    },
  };
}

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

async function glideTo(page: Page, x: number, y: number) {
  await page.mouse.move(x, y, { steps: 30 });
  await pause(page, 250);
}
async function glideClick(page: Page, target: Locator) {
  const b = (await target.boundingBox())!;
  await glideTo(page, b.x + b.width / 2, b.y + b.height / 2);
  await target.click();
}
const typeSlow = (target: Locator, text: string) => target.pressSequentially(text, { delay: 45 });

describe.skipIf(!process.env.DEMO)('demo', () => {
  it('records the walkthrough', { timeout: 600_000 }, async () => {
    const you = await youWav();
    const ext = await launch({ fakeAudio: you });
    await ext.ctx.addInitScript(CURSOR);
    await ext.ctx.addInitScript(AUDIO_TAP);
    const sounds: Sound[] = [];
    await ext.ctx.exposeFunction('__demoAudio', (s: Sound) => void sounds.push(s));
    // The extension's own OpenAI request, in the voice it maps "autumn" to.
    await ext.ctx.route('https://api.groq.com/openai/v1/audio/speech', async (route) => {
      const { input } = route.request().postDataJSON() as { input: string };
      await route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav' }, body: await openaiSpeech(input, 'marin', OPENAI_INSTRUCTIONS) });
    });
    let narrated = 0;
    const pdf = readFileSync(process.env.DEMO_PDF!);
    await ext.ctx.route('https://arxiv.org/pdf/**', (r) => r.fulfill({ contentType: 'application/pdf', body: pdf }));
    await mockClaude(ext, (system, prompt) =>
      system.includes('Socratic tutor')
        ? [
            "So, Attention Is All You Need. Before we dig in, what do you think it's actually trying to fix?",
            "Okay, recurrence is slow. But why does reading one word at a time stop you from using a GPU well?",
            "Right, nothing can run in parallel. So if attention looks at every word at once, how does it still know their order?",
          ][Math.min(2, prompt.split('Them:').length - 1)]
        : system.includes('into narration')
          ? (['Section one, Introduction. Recurrent networks, like LSTMs, have been the standard for sequence tasks such as translation. But they read one position at a time, and each step waits for the one before it, so training cannot be parallelized within a sequence.',
              'Background. Earlier work tried to cut that sequential cost with convolutions, but then relating two distant words takes more and more steps. The Transformer brings that down to a constant number, using attention.'][narrated++] ?? '[SKIP]')
        : system.includes('looping')
          ? 'Lighter:\n- Reading group is Thursday; picking the paper is one small decision, not a project.\n- The GPU quota email is a two-minute reply.\n- Not getting the square-root scaling yet is normal: it is one question, not the whole paper.\n- Laundry can wait until tonight.\n\n' +
            `Top tasks:\n- | Pick the reading group paper\n- ${today(16)} | Reply to Priya about the GPU quota\n- | Work out why attention divides by the square root of d`
        : system.includes('clicked')
        ? '**Transformer**: a sequence model built only from attention: every token looks at every other token directly, with no recurrence or convolution.'
        : system.includes('asking, never telling')
          ? 'If nothing is recurrent, how does the model know which word came first?'
          : system.includes('check whether a reader understood')
            ? '```json\n[{"part":"problem","status":"got","gap":"","page":null},' +
              '{"part":"trick","status":"partial","gap":"You named attention but not what it replaces.","page":2},' +
              '{"part":"why","status":"missing","gap":"Say why dropping recurrence makes training faster.","page":6}]\n```'
            : '[]',
    );
    const now = Date.now();
    await seed(ext, {
      settings: {
        claudeKey: 'sk-demo',
        groqKey: process.env.GROQ_API_KEY,
        openaiKey: process.env.OPENAI_API_KEY,
        talkVoice: 'autumn',
        focusBlocklist: ['linkedin.com', 'youtube.com', 'x.com', 'reddit.com', 'netflix.com'],
      },
      // An existing vault, so the brain dump seals straight in (no passphrase setup on camera).
      vault: TS_VAULT.vault,
      lockedDumps: TS_VAULT.lockedDumps,
      dumps: [],
      todos: [
        { id: 't1', text: 'Finish section 3.2 of Attention Is All You Need', dueAt: todayMs(15), doneAt: null, rank: 0 },
        { id: 't2', text: 'Email advisor about the reading list', dueAt: null, doneAt: null, rank: 1 },
        { id: 't3', text: 'Re-read the BLEU results table', dueAt: null, doneAt: null, rank: 2 },
        { id: 't4', text: 'Annotate Mamba section 3', dueAt: null, doneAt: null, startedAt: now - 1_800_000, rank: 0 },
        { id: 't5', text: 'Submit ML homework 4', dueAt: null, doneAt: now - 7_200_000, rank: 0 },
      ],
      folders: [folder, done],
      papers: [
        paper('1', 'Attention Is All You Need', {
          id: ARXIV,
          url: `https://arxiv.org/abs/${ARXIV}`,
          authors: 'A. Vaswani, N. Shazeer, N. Parmar, et al.',
          year: 2017,
          progressPercent: 35,
          leftOff: '3.2 Attention',
          lastReadAt: now - 60_000,
        }),
        paper('2', 'Mamba: Linear-Time Sequence Modeling with Selective State Spaces', { authors: 'A. Gu, T. Dao', year: 2023, progressPercent: 60, leftOff: '3.2 Selective scan', lastReadAt: now - 3_600_000 }),
        paper('3', 'Language Models are Few-Shot Learners', { authors: 'T. Brown et al.', year: 2020, progressPercent: 0, lastReadAt: null }),
        paper('4', 'Scaling Laws for Neural Language Models', { authors: 'J. Kaplan et al.', year: 2020, progressPercent: 0, lastReadAt: null }),
        paper('5', 'Denoising Diffusion Probabilistic Models', { authors: 'J. Ho, A. Jain, P. Abbeel', year: 2020, progressPercent: 100, folderIds: [done.id] }),
      ],
      explainBacks: {
        [`arxiv:${ARXIV}`]: [
          {
            at: now - 86_400_000,
            problem: 'p',
            trick: 't',
            why: '',
            grades: [
              { part: 'problem', status: 'got', gap: '', page: null },
              { part: 'why', status: 'missing', gap: 'Say why dropping recurrence makes training faster.', page: 6 },
            ],
          },
        ],
      },
      lexicon: bigLexicon(),
    });

    // One tab for the whole take, so it is one video.
    const page = await ext.page(PAGES.newtab);
    const cam = record(page, join(OUT, 'demo'));
    try {
    await pause(page, 4000);

    // Brain dump: empty your head, Cmd+Enter; Haiku hands it back lighter and puts the top tasks on today's board.
    const dump = page.getByLabel('Empty your head here');
    await glideClick(page, dump);
    await dump.pressSequentially(
      "too many tabs open. reading group is thursday and I haven't picked a paper. need to reply to Priya about the GPU quota. still don't get why attention divides by root d. laundry",
      { delay: 22 },
    );
    await pause(page, 600);
    await dump.press('Meta+Enter');
    await page.locator('.notebook-bullets li').first().waitFor({ timeout: 15_000 });
    await page.getByText('Added 3 tasks to your board. Undo leaves any you have edited or started.').waitFor({ timeout: 15_000 });
    await pause(page, 4000);
    // The three tasks landed at the bottom of To do.
    await glideTo(page, 560, 200);
    await page.mouse.wheel(0, 600);
    await pause(page, 3500);
    await page.mouse.wheel(0, -600);
    await pause(page, 1000);

    // The bookshelf: walk it by keyboard, pull a paper out.
    await cam.go(`chrome-extension://${ext.id}/${PAGES.papers}`);
    await page.locator('.book').first().waitFor();
    await pause(page, 2500);
    await page.locator('#book-0-0').focus();
    for (const key of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft']) {
      await page.keyboard.press(key);
      await pause(page, 600);
    }
    await page.keyboard.press('Enter');
    await page.locator('.book-card[role="dialog"]').waitFor();
    await pause(page, 3500);
    await page.keyboard.press('Escape');
    await pause(page, 1000);

    // The reader, on the real paper.
    await cam.go(`chrome-extension://${ext.id}/${PAGES.reader}?src=${encodeURIComponent(`https://arxiv.org/pdf/${ARXIV}`)}`);
    await page.waitForSelector('.reader-page[aria-label^="Page 1 "] .textLayer span');
    await pause(page, 2500);

    // Click a term: it asks for a guess before it defines.
    await page.$$eval('.reader-page[aria-label^="Page 1 "] .textLayer span', (spans) =>
      spans.find((s) => s.textContent?.includes('Transformer'))?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    );
    await pause(page, 2000);
    const at =await page.$$eval('.reader-page[aria-label^="Page 1 "] .textLayer span', (spans) => {
      for (const span of spans) {
        const node = span.firstChild as Text | null;
        const i = node?.data.indexOf('Transformer') ?? -1;
        if (!node || i < 0) continue;
        const range = document.createRange();
        range.setStart(node, i + 3);
        range.setEnd(node, i + 4);
        const r = range.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      throw new Error('no "Transformer" on page 1');
    });
    await glideTo(page, at.x, at.y);
    await page.mouse.click(at.x, at.y);
    const popover = page.getByRole('dialog', { name: /^Definition of/ });
    await popover.waitFor();
    await pause(page, 1200);
    await typeSlow(popover.getByRole('textbox'), 'a model that uses attention');
    await pause(page, 500);
    await glideClick(page, popover.getByRole('button', { name: 'Compare' }));
    await popover.getByText('Save as a note here?').waitFor({ timeout: 15_000 });
    await pause(page, 4000);
    await glideClick(page, popover.getByRole('button', { name: 'Save note' }));
    await pause(page, 1500);

    // Q: it asks a question about where you are, never tells.
    await page.keyboard.press('q');
    const card = page.getByRole('complementary', { name: 'A question for you' });
    await card.getByText('which word came first').waitFor({ timeout: 15_000 });
    await pause(page, 1500);
    await typeSlow(card.getByLabel('Your answer, in your own words'), 'Positional encodings added to the embeddings.');
    await pause(page, 500);
    await glideClick(page, card.getByRole('button', { name: 'Keep as a note' }));
    await pause(page, 1500);

    // E: explain it back; graded to the gap and where to look, not the answer.
    await page.keyboard.press('e');
    const panel = page.getByRole('region', { name: 'Explain it back' });
    await panel.waitFor();
    await pause(page, 1000);
    await typeSlow(panel.getByLabel('The problem'), 'RNNs are slow to train on long sequences.');
    await typeSlow(panel.getByLabel('The key trick'), 'Use attention everywhere.');
    await pause(page, 500);
    await glideClick(page, panel.getByRole('button', { name: 'Check my explanation' }));
    await panel.getByText('You named attention but not what it replaces.').waitFor({ timeout: 15_000 });
    await pause(page, 4500);
    await glideClick(page, panel.getByRole('button', { name: 'Look at page 2' }));
    await pause(page, 3000);

    // While a paper is open, distracting sites are blocked: even this one.
    await expect
      .poll(() => ext.sw.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).some((r) => r.id >= 1000 && r.id < 2000)))
      .toBe(true);
    const other = await ext.ctx.newPage();
    await cam.watch(other);
    await cam.go('https://www.linkedin.com/feed/', other);
    await other.waitForURL((u) => u.pathname.endsWith('/src/pages/blocked/index.html'), { timeout: 10_000 });
    await other.locator('h1', { hasText: 'is blocked while you read' }).waitFor();
    await pause(other, 4500);
    await glideClick(other, other.getByRole('button', { name: 'Back to your paper' }));
    await pause(other, 600);
    await cam.watch(page);
    await page.bringToFront();
    await other.close();
    await pause(page, 1500);

    // Talk it through: it speaks first, you answer out loud, Whisper writes it down.
    await glideTo(page, 900, 12);
    await glideClick(page, page.getByRole('button', { name: 'Talk it through' }));
    await page.getByRole('heading', { name: 'Talk it through' }).waitFor();
    await pause(page, 1500);
    await glideClick(page, page.getByRole('button', { name: 'Start talking' }));
    const agent = page.locator('[data-who="agent"]');
    const phase = () => page.locator('[data-phase]').getAttribute('data-phase');
    await page.locator('[data-who="you"]').first().waitFor({ timeout: 90_000 });
    await agent.nth(1).waitFor({ timeout: 60_000 });
    // Its second question has played: stop before the mic hears "you" again.
    await expect.poll(phase, { timeout: 90_000, interval: 100 }).toBe('listening');
    await glideClick(page, page.getByRole('button', { name: 'Stop' }));
    await pause(page, 1000);

    // Can't talk? Type the turn instead; it still answers aloud.
    await glideClick(page, page.getByLabel('Or type it'));
    await typeSlow(page.getByLabel('Or type it'), "Because each step waits for the last one, so nothing runs in parallel.");
    await pause(page, 400);
    await page.keyboard.press('Enter');
    await agent.nth(2).waitFor({ timeout: 60_000 });
    await expect.poll(phase, { timeout: 90_000, interval: 200 }).toBe('off');
    await pause(page, 2000);

    // Listen: the paper read aloud, a page at a time, from where you are.
    await glideTo(page, 900, 12);
    await glideClick(page, page.getByRole('button', { name: 'Listen', exact: true }));
    await glideClick(page, page.getByRole('button', { name: /^Read from page/ }));
    await page.locator('.reader-talk-turns', { hasText: 'Background.' }).waitFor({ timeout: 90_000 });
    await pause(page, 9000);
    await glideTo(page, 900, 12);
    await glideClick(page, page.getByRole('button', { name: 'Listen', exact: true }));
    await pause(page, 1500);

    // The lexicon: every term kept from every paper, as a graph.
    await cam.go(`chrome-extension://${ext.id}/${PAGES.lexicon}`);
    await page.locator('.lex-node').first().waitFor();
    // Let the whole network fly into place.
    await pause(page, 6000);
    await glideClick(page, page.locator('.lex-node', { hasText: /^Transformer$/ }));
    await pause(page, 3500);
    // A link chip walks the graph: what the Transformer replaced.
    await glideClick(page, page.getByRole('button', { name: /replaces.*Recurrence/ }));
    await pause(page, 3000);
    await glideClick(page, page.getByRole('button', { name: /suffers from.*Vanishing gradient/ }));
    await pause(page, 3000);
    await page.keyboard.press('Escape');
    await pause(page, 1500);
    const fit = page.getByRole('button', { name: 'Fit', exact: true }).first();
    if (await fit.isEnabled()) await glideClick(page, fit);
    await pause(page, 2500);

    // Back to the new tab: the paper and its open gaps.
    await cam.go(`chrome-extension://${ext.id}/${PAGES.newtab}`);
    await pause(page, 4000);
    } catch (e) {
      await page.screenshot({ path: join(OUT, 'demo-failed.png') });
      throw e;
    } finally {
      const { count, t0 } = await cam.stop();
      await page.close();
      await ext.close();
      const clips = mux(join(OUT, 'demo'), t0, sounds, you, join(OUT, 'demo.mp4'));
      console.log(`${count} frames, ${clips} sounds`);
      for (const s of sounds) console.log(s.kind, s.id, s.at - t0);
    }
  });
});
