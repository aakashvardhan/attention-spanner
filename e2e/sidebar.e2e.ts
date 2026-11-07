import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGES, expectA11y, launch, mockClaude, seed, type Ext } from './harness';
import { html } from './sites';

/**
 * The side panel for any webpage: the page's main text (math as LaTeX) is
 * read by an injected script, cut into sections, and narrated or talked
 * through with the paper reader's panels.
 */

const FIXTURE = readFileSync(resolve(__dirname, 'fixtures/webpage.html'), 'utf8');

/** A 1.5 s, 220 Hz tone at 24 kHz (as in listen.e2e.ts). */
function toneWav(seconds = 1.5): Buffer {
  const n = Math.round(24_000 * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24_000, 24);
  b.writeUInt32LE(48_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 24_000)), 44 + i * 2);
  return b;
}

type Extracted = { title: string; blocks: { level: number; text: string }[] };

describe('side panel: webpage', () => {
  let ext: Ext;
  let url = '';

  /** Open `path` on the notes site in a tab; its id. */
  async function openTab(path: string): Promise<number> {
    const page = await ext.ctx.newPage();
    await page.goto(`${ext.sites.origin('notes')}${path}`);
    return ext.sw.evaluate(
      async (u) => (await chrome.tabs.query({ url: u }))[0].id!,
      `${ext.sites.origin('notes')}${path}`,
    );
  }

  /** Every Claude call's raw request body, newest last. */
  const bodies: string[] = [];
  /** What Groq was asked to say. */
  const spoken: string[] = [];
  let calls: { system: string; prompt: string; images: number }[] = [];
  const NARRATION = 'Section one: Agent evaluation. This asks how we know an agent did well.';

  beforeAll(async () => {
    ext = await launch();
    calls = await mockClaude(ext, (system) =>
      system.includes('thinking partner') ? 'What do you think a good metric would reward?' : NARRATION,
    );
    await ext.ctx.route('https://api.anthropic.com/**', async (route) => {
      bodies.push(route.request().postData() ?? '');
      await route.fallback();
    });
    const wav = toneWav();
    await ext.ctx.route('https://api.groq.com/**', async (route) => {
      spoken.push(route.request().postDataJSON().input);
      await route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav' }, body: wav });
    });
    await seed(ext, { settings: { claudeKey: 'sk-e2e', groqKey: 'gsk-e2e' } });
    ext.sites.setRoute('notes', '/agent-evaluation', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE);
    });
    ext.sites.setRoute('notes', '/second', html('<main><h1>Second page</h1><p>Other.</p></main>'));
    ext.sites.setRoute('notes', '/nav-only', html('<nav><a href="/">Home</a></nav>'));
    url = `${ext.sites.origin('notes')}/agent-evaluation`;
  });
  afterAll(async () => ext?.close());

  it('reads the main text with math as LaTeX, leaving out menus and footers', async () => {
    const tabId = await openTab('/agent-evaluation');
    const r: Extracted = await ext.sw.evaluate(
      async (id) => (await chrome.scripting.executeScript({ target: { tabId: id }, files: ["page-text.js"] }))[0].result as Extracted,
      tabId,
    );
    const text = r.blocks.map((b) => b.text).join('\n');
    expect(r.title).toBe('Agent evaluation');
    expect(r.blocks[0]).toEqual({ level: 1, text: 'Agent evaluation' });
    expect(text).toContain('$p(y \\mid x)$');
    expect(text).toContain('$$\\sum_i r_i$$');
    expect(text).toContain('$$E = mc^2$$');
    expect(text).toContain('Nested paragraph point');
    expect(text).toContain('def f(x):\n    return x');
    expect(text).not.toMatch(/p\(y∣x\)|E=mc2|∑ri|Home|Courses|Site banner|Related posts|Copyright/);
    // The live page is untouched.
    const page = ext.ctx.pages().find((p) => p.url() === url)!;
    expect(await page.locator('.katex-html').count()).toBe(2);
  });

  it('narrates the page section by section, from LaTeX, with no picture', async () => {
    const tabId = await openTab('/agent-evaluation');
    const side = await ext.page(`${PAGES.sidebar}?tab=${tabId}`);
    await expect.poll(() => side.getByRole('heading', { name: 'Agent evaluation' }).count()).toBe(1);
    await side.getByRole('button', { name: 'Read the page' }).click();
    await expect.poll(() => side.getByText("That's the end of the page.").count(), { timeout: 20_000 }).toBe(1);
    const narrate = calls.filter((c) => c.system.includes('one section of the web page'));
    expect(narrate.length).toBe(2);
    expect(narrate[0].prompt).toContain('section 1 of 2');
    expect(narrate.every((c) => c.images === 0)).toBe(true);
    expect(bodies.some((b) => b.includes('$p(y \\\\mid x)$'))).toBe(true);
    expect(spoken.join(' ')).toContain('how we know an agent did well');
    await expectA11y(side, 'sidebar');
    await side.close();
  });

  it('talks it through about the page, asking, never telling', async () => {
    const tabId = await openTab('/agent-evaluation');
    const side = await ext.page(`${PAGES.sidebar}?tab=${tabId}`);
    await side.getByRole('button', { name: 'Talk it through' }).click();
    await side.locator('#talk-type').fill('It measures success rate.');
    await side.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => side.getByText('What do you think a good metric would reward?').count(), { timeout: 15_000 }).toBeGreaterThan(0);
    const talk = calls.filter((c) => c.system.includes('thinking partner')).at(-1)!;
    expect(talk.system).toContain('the page "Agent evaluation"');
    expect(talk.system).toContain('you never tell');
    await side.close();
  });

  it('forgets the page when the tab goes somewhere else', async () => {
    const tabId = await openTab('/agent-evaluation');
    const side = await ext.page(`${PAGES.sidebar}?tab=${tabId}`);
    await side.getByRole('button', { name: 'Read the page' }).click();
    await expect.poll(() => side.getByRole('button', { name: 'Pause' }).count(), { timeout: 10_000 }).toBe(1);
    await ext.sw.evaluate((a) => chrome.tabs.update(a.id, { url: a.url }), { id: tabId, url: `${ext.sites.origin('notes')}/second` });
    await expect.poll(() => side.getByRole('heading', { name: 'Second page' }).count(), { timeout: 5_000 }).toBe(1);
    expect(await side.getByRole('button', { name: 'Read the page' }).count()).toBe(1);
    expect(await side.getByRole('button', { name: 'Pause' }).count()).toBe(0);
    // The old page's narration stops: nothing more goes to the voice.
    const said = spoken.length;
    await side.waitForTimeout(2_000);
    expect(spoken.length).toBe(said);
    await side.close();
  });

  it("says so on a page it can't read, or one with no text", async () => {
    const newtab = await ext.page(PAGES.newtab);
    const ownId = await newtab.evaluate(async () => (await chrome.tabs.getCurrent())!.id!);
    const side = await ext.page(`${PAGES.sidebar}?tab=${ownId}`);
    await expect.poll(() => side.getByText("This page can't be read here.").count()).toBe(1);
    expect(await side.getByRole('button', { name: 'Read the page' }).count()).toBe(0);
    const navId = await openTab('/nav-only');
    const side2 = await ext.page(`${PAGES.sidebar}?tab=${navId}`);
    await expect.poll(() => side2.getByText("Couldn't find any text on this page.").count()).toBe(1);
  });

  it('the toolbar icon opens the side panel', async () => {
    const r = await ext.sw.evaluate(async () => ({
      path: (chrome.runtime.getManifest() as { side_panel?: { default_path: string } }).side_panel?.default_path,
      behavior: await chrome.sidePanel.getPanelBehavior(),
    }));
    expect(r.path).toBe('src/pages/sidebar/index.html');
    expect(r.behavior.openPanelOnActionClick).toBe(true);
  });
});
