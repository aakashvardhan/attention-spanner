import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import { expect } from 'vitest';
import { A11Y_BASELINE } from './a11yBaseline';
import { startSites, type Sites } from './sites';

/** The build under test (`npm run build:ext`); DIST points elsewhere, e.g. at an unpacked release. */
const DIST = resolve(process.env.DIST ?? resolve(__dirname, '..', 'rust/ext/dist/chromium'));
export const OUT = resolve(__dirname, 'out');

export const PAGES = {
  newtab: 'src/pages/newtab/index.html',
  options: 'src/pages/options/index.html',
  papers: 'src/pages/papers/index.html',
  lexicon: 'src/pages/lexicon/index.html',
  reader: 'src/pages/reader/index.html',
  blocked: 'src/pages/blocked/index.html#https://example.com/',
} as const;

export interface Ext {
  ctx: BrowserContext;
  sw: Worker;
  id: string;
  sites: Sites;
  /** Every console error and uncaught exception, from any page */
  errors: string[];
  /** Opens an extension page and waits for storage-driven UI to settle */
  page(path: string): Promise<Page>;
  close(): Promise<void>;
}

/** `fakeAudio`: a WAV the browser plays as the microphone (looped), with the permission prompt auto-accepted. */
export async function launch(opts: { fakeAudio?: string } = {}): Promise<Ext> {
  const sites = await startSites();
  const profile = mkdtempSync(join(tmpdir(), 'reader-e2e-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: !process.env.HEADED,
    channel: 'chromium',
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      `--host-resolver-rules=MAP *.e2e.test 127.0.0.1`,
      // The fake sites live on 127.0.0.1. Real feeds are on the public
      // internet, so Chrome's local-network checks never apply to users; here
      // they would only stand between the suite and its own server.
      '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights',
      ...(opts.fakeAudio
        ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${opts.fakeAudio}`]
        : []),
    ],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;

  const errors: string[] = [];
  ctx.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()} (${msg.location().url})`);
  });
  ctx.on('weberror', (err) => errors.push(`uncaught: ${err.error().message}`));

  // Let onInstalled (migrate, alarms) finish before a test seeds storage over it.
  await sw.evaluate(() => new Promise((r) => setTimeout(r, 300)));

  return {
    ctx,
    sw,
    id,
    sites,
    errors,
    async page(path) {
      const page = await ctx.newPage();
      await page.goto(`chrome-extension://${id}/${path}`);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(800);
      return page;
    },
    async close() {
      await ctx.close();
      await sites.close();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

export async function seed(ext: Ext, data: Record<string, unknown>): Promise<void> {
  await ext.sw.evaluate((d) => chrome.storage.local.set(d), data);
}

export async function storage<T>(ext: Ext, key: string): Promise<T> {
  return ext.sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key) as Promise<T>;
}

export { NETWORK_NOISE } from './noise';

/** Fails on any console error or uncaught exception not matched by `allow`. */
export function expectClean(ext: Ext, allow: RegExp[] = []): void {
  // Emptied first, so a failing assertion cannot leak into the next test.
  const unexpected = ext.errors.splice(0).filter((e) => !allow.some((re) => re.test(e)));
  expect(unexpected).toEqual([]);
}

const require = createRequire(__filename);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/**
 * WCAG 2.2 A/AA violations on the page as it is now. Injected through
 * page.evaluate, not a script tag: extension pages run under
 * `script-src 'self'`, which blocks inline scripts but not CDP evaluation.
 */
export async function axe(page: Page): Promise<{ id: string; nodes: number }[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const run = (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe.run;
    const result = await run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] });
    return result.violations.map((v) => ({ id: v.id, nodes: v.nodes.length }));
  });
}

/**
 * Wait out running transitions and animations (capped at 2s). A theme switch
 * eases colours over a few hundred ms; contrast measured mid-ease is neither
 * theme's real contrast.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // Two frames first: a media change starts its transitions at the next
    // style recalc, so asking for animations right away finds none.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await Promise.race([
      Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  });
}

/**
 * No violation outside the baseline, and no baselined violation that has gone
 * away (so the baseline only ever shrinks).
 */
export async function expectA11y(page: Page, pageName: string): Promise<void> {
  await settle(page);
  const found = (await axe(page)).map((v) => v.id).sort();
  const known = (A11Y_BASELINE[pageName] ?? []).map((k) => k.rule).sort();
  expect({ page: pageName, violations: found }).toEqual({ page: pageName, violations: known });
}

export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}

/** Wide content at 200% zoom: the page at half the width must not scroll sideways. */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/**
 * Claude, scripted: every Messages API call is answered by `reply(system, prompt)`
 * as a two-chunk SSE stream in the shape the Anthropic SDK reads. Calls are
 * recorded so a test can check what was asked. Extension pages hold host
 * permissions, so no CORS headers are needed.
 */
export async function mockClaude(ext: Ext, reply: (system: string, prompt: string) => string) {
  const calls: { system: string; prompt: string; model: string }[] = [];
  await ext.ctx.route('https://api.anthropic.com/**', async (route) => {
    const body = route.request().postDataJSON() as {
      model: string;
      system: string;
      messages: { content: { text: string }[] }[];
    };
    const prompt = body.messages[0].content.at(-1)?.text ?? '';
    calls.push({ system: body.system, prompt, model: body.model });
    const text = reply(body.system, prompt);
    const mid = Math.floor(text.length / 2);
    const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body:
        event('message_start', {
          message: { id: 'msg_e2e', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
        }) +
        event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
        event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(0, mid) } }) +
        event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(mid) } }) +
        event('content_block_stop', { index: 0 }) +
        event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }) +
        event('message_stop', {}),
    });
  });
  return calls;
}

/**
 * Groq Whisper, scripted: `reply()` answers each transcription as
 * `{ status, text }`. Each call records the uploaded WAV's PCM byte count
 * (its `data` chunk) so a test can check silence was trimmed before upload.
 */
export async function mockGroq(ext: Ext, reply: () => { status: number; text?: string }) {
  const calls: { wavBytes: number; model: string }[] = [];
  await ext.ctx.route('https://api.groq.com/**', async (route) => {
    const body = route.request().postDataBuffer() ?? Buffer.alloc(0);
    const riff = body.indexOf('RIFF');
    const data = body.indexOf('data', riff);
    const model = /name="model"\r\n\r\n([^\r]+)/.exec(body.toString('latin1'))?.[1] ?? '';
    calls.push({ wavBytes: riff < 0 || data < 0 ? -1 : body.readUInt32LE(data + 4), model });
    const { status, text } = reply();
    await route.fulfill({
      status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(status === 200 ? { text } : { error: { message: 'mock' } }),
    });
  });
  return calls;
}

/** Per OS: font rendering differs between macOS and Linux CI, and a baseline only means something on the OS that drew it. */
const BASELINES = resolve(__dirname, 'baselines', process.platform);

/**
 * Screenshot regression without a new dependency: the baseline and the fresh
 * shot are decoded and compared in the page itself, on canvases. A missing
 * baseline is written (commit it); UPDATE_BASELINES=1 rewrites them after an
 * intended change. Fails when more than 0.5% of pixels move by more than 24
 * in any channel, which absorbs anti-aliasing but not a layout or colour change.
 * Baselines are per OS (macOS is committed). CI on another OS writes its own
 * on first run and uploads them; commit those to make CI compare too.
 */
export async function expectScreenshot(page: Page, name: string): Promise<void> {
  await settle(page);
  const actual = await page.screenshot({ fullPage: true });
  const file = join(BASELINES, `${name}.png`);
  mkdirSync(BASELINES, { recursive: true });
  let baseline: Buffer;
  try {
    if (process.env.UPDATE_BASELINES) throw new Error('update');
    baseline = readFileSync(file);
  } catch {
    writeFileSync(file, actual);
    return;
  }
  const result = await page.evaluate(
    async ([a, b]) => {
      const decode = async (b64: string) => createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const [x, y] = await Promise.all([decode(a), decode(b)]);
      if (x.width !== y.width || x.height !== y.height) return { size: `${x.width}x${x.height} vs ${y.width}x${y.height}`, changed: 1 };
      const read = (img: ImageBitmap) => {
        const c = new OffscreenCanvas(img.width, img.height);
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height).data;
      };
      const [p, q] = [read(x), read(y)];
      let changed = 0;
      for (let i = 0; i < p.length; i += 4)
        if (Math.abs(p[i] - q[i]) > 24 || Math.abs(p[i + 1] - q[i + 1]) > 24 || Math.abs(p[i + 2] - q[i + 2]) > 24) changed++;
      return { size: '', changed: changed / (p.length / 4) };
    },
    [baseline.toString('base64'), actual.toString('base64')] as const,
  );
  if (result.changed > 0.005) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${name}.actual.png`), actual);
  }
  expect(result.size, `${name}: page size changed (actual in e2e/out)`).toBe('');
  expect(result.changed, `${name}: share of pixels changed (actual in e2e/out)`).toBeLessThanOrEqual(0.005);
}
