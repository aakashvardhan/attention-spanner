import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Annotation } from '../src/shared/types';
import { PAGES, launch, seed, shot, storage, type Ext } from './harness';

/**
 * The PDF reader's reading aids, end to end against a scripted Ollama: a
 * clicked term guessed then defined in place, a one-liner for the page just left, and the
 * Paperwhite theme. Model output is fixed, so this checks the wiring, not the
 * model.
 */

const LINE = 'The transformer reads a sentence and BLEU scores the translation it writes back out.';

/** A minimal valid PDF: each page holds a few lines of plain Helvetica text. */
function makePdf(pages: number): Buffer {
  const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i++) {
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R ` +
        '/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
    );
    const lines = Array.from({ length: 6 }, (_, l) => `1 0 0 1 72 ${700 - l * 40} Tm (${LINE}) Tj`).join(' ');
    const stream = `BT /F1 11 Tf ${lines} ET`;
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * One page covered by an 8x8 all-black CCITT G3 image, the encoding of most
 * scanned old papers. pdf.js decodes it in wasm, so it only paints if the
 * wasm files ship and the CSP lets them compile.
 */
function makeScannedPdf(): Buffer {
  // Each row: white run 0 (00110101), then black run 8 (000101).
  const bits = '00110101000101'.repeat(8);
  const img = Buffer.from(Array.from({ length: bits.length / 8 }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
  const content = 'q 612 0 0 792 0 0 cm /Im1 Do Q';
  const objs = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>',
    ),
    Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    Buffer.concat([
      Buffer.from(
        '<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 1 ' +
          `/Filter /CCITTFaxDecode /DecodeParms << /K 0 /Columns 8 /Rows 8 >> /Length ${img.length} >>\nstream\n`,
      ),
      img,
      Buffer.from('\nendstream'),
    ]),
  ];
  const parts = [Buffer.from('%PDF-1.4\n')];
  let length = parts[0].length;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(length);
    const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    parts.push(part);
    length += part.length;
  });
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  tail += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(tail));
  return Buffer.concat(parts);
}

/** Ollama's health check and a streaming /api/chat that answers by task. */
async function startChatMock() {
  const chats: { system: string; think: unknown }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'mock' }] }));
      if (req.url === '/api/show') return res.end('{}');
      if (req.url === '/api/chat') {
        const { messages, think } = JSON.parse(body) as { messages: { content: string }[]; think: unknown };
        const system = messages[0].content;
        chats.push({ system, think });
        const reply = system.includes('clicked')
          ? '**Transformer**: an attention-based sequence model.'
          : 'This page explained how the transformer is scored with BLEU.';
        res.setHeader('content-type', 'application/x-ndjson');
        // Two chunks, so the reader sees a stream rather than one blob.
        const mid = Math.floor(reply.length / 2);
        res.write(JSON.stringify({ message: { content: reply.slice(0, mid) }, done: false }) + '\n');
        res.end(JSON.stringify({ message: { content: reply.slice(mid) }, done: true }) + '\n');
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, chats, close: () => new Promise((r) => server.close(() => r(undefined))) };
}

describe('reader: key terms, page one-liners, paperwhite', () => {
  let ext: Ext;
  let ollama: Awaited<ReturnType<typeof startChatMock>>;
  let pdfUrl: string;

  beforeAll(async () => {
    ext = await launch();
    ollama = await startChatMock();
    const pdf = makePdf(4);
    ext.sites.setRoute('papers', '/paper.pdf', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(pdf);
    });
    pdfUrl = `${ext.sites.origin('papers')}/paper.pdf`;
    const scanned = makeScannedPdf();
    ext.sites.setRoute('papers', '/scanned.pdf', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(scanned);
    });
    // A web URL is a private source, so every call stays on the (mock) local model.
    await seed(ext, {
      settings: { ollamaUrl: ollama.url, ollamaChatModel: 'mock', layaUrl: '', theme: 'paperwhite', cloudMode: 'off' },
    });
  });

  afterAll(async () => {
    await ext?.close();
    await ollama?.close();
  });

  it('asks for a guess before defining, and a one-liner for the page just left', async () => {
    const page = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(pdfUrl)}`);
    await page.waitForSelector('[aria-label^="Page 1 of"] .textLayer span');

    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('paperwhite');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(243, 229, 196)');

    // Click the middle of "transformer" in the first line.
    const at = await page.$eval('.reader-page[aria-label^="Page 1 "] .textLayer span', (span) => {
      const node = span.firstChild as Text;
      const start = node.data.indexOf('transformer');
      const range = document.createRange();
      range.setStart(node, start + 3);
      range.setEnd(node, start + 4);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(at.x, at.y);
    const popover = page.getByRole('dialog', { name: 'Definition of transformer' });
    // A guess comes first: nothing to compare until one is written.
    const compare = popover.getByRole('button', { name: 'Compare' });
    expect(await compare.isDisabled()).toBe(true);
    await popover.getByRole('textbox').fill('a model');
    await compare.click();
    await expect.poll(() => popover.textContent()).toContain('Your guess');
    await expect.poll(() => popover.textContent(), { timeout: 10_000 }).toContain('attention-based sequence model');
    const asked = ollama.chats.find((c) => c.system.includes('clicked'));
    expect(asked).toBeDefined();
    await shot(page, 'reader-paperwhite-define');

    // A click elsewhere closes it.
    await page.mouse.click(5, 300);
    await expect.poll(() => popover.count()).toBe(0);

    // Pass 2: settle on page 1, then move to page 2. The capsule asks about page 1.
    await page.getByRole('radio', { name: 'Pass 2' }).click();
    await page.waitForTimeout(1500);
    await page.locator('.reader-viewport').evaluate((el) => {
      const second = el.querySelector<HTMLElement>('.reader-page[aria-label^="Page 2 "]')!;
      el.scrollTop = second.offsetTop;
    });
    const prompt = page.getByRole('group', { name: 'Reflection prompt' });
    await expect.poll(() => prompt.textContent(), { timeout: 10_000 }).toContain('what did page 1 claim?');
    expect(await page.getByRole('complementary', { name: 'Recap of page 1' }).count()).toBe(0);
    await shot(page, 'reader-paperwhite-one-liner');

    // Every local call skipped the model's thinking: it is most of the latency.
    expect(ollama.chats.length).toBeGreaterThanOrEqual(1);
    expect(ollama.chats.every((c) => c.think === false)).toBe(true);
    await page.close();
  });

  it('shows no drift message after the reader sits idle', async () => {
    const page = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(pdfUrl)}`);
    await page.waitForSelector('[aria-label^="Page 1 of"] .textLayer span');
    await page.clock.install();
    await page.clock.fastForward(200_000);
    expect(await page.getByText(/^You were at/).count()).toBe(0);
    await page.close();
  });

  it('offers to keep a definition as a note on the clicked term', async () => {
    const page = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(pdfUrl)}`);
    await page.waitForSelector('[aria-label^="Page 1 of"] .textLayer span');
    const clickWord = async (word: string, line: number) => {
      const at = await page.$$eval(
        '.reader-page[aria-label^="Page 1 "] .textLayer span',
        (spans, [w, n]) => {
          const node = spans[n as number].firstChild as Text;
          const start = node.data.indexOf(w as string);
          const range = document.createRange();
          range.setStart(node, start + 2);
          range.setEnd(node, start + 3);
          const r = range.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        },
        [word, line],
      );
      await page.mouse.click(at.x, at.y);
      const dialog = page.getByRole('dialog', { name: `Definition of ${word}` });
      await dialog.getByRole('textbox').fill('a model');
      await dialog.getByRole('button', { name: 'Compare' }).click();
    };
    const highlights = page.locator('.reader-page[aria-label^="Page 1 "] .annot-highlight');
    const before = await highlights.count();

    // Declined: the prompt goes, the definition stays, nothing is stored.
    await clickWord('transformer', 1);
    let popover = page.getByRole('dialog', { name: 'Definition of transformer' });
    await expect.poll(() => popover.textContent(), { timeout: 10_000 }).toContain('attention-based sequence model');
    await popover.getByRole('button', { name: 'No', exact: true }).click();
    expect(await popover.getByText('Save as a note here?').count()).toBe(0);
    expect(await popover.textContent()).toContain('attention-based sequence model');
    expect(await highlights.count()).toBe(before);
    await page.keyboard.press('Escape');

    // Accepted: the term is highlighted with the definition as its note.
    await clickWord('transformer', 2);
    popover = page.getByRole('dialog', { name: 'Definition of transformer' });
    await expect.poll(() => popover.getByText('Save as a note here?').count(), { timeout: 10_000 }).toBe(1);
    await popover.getByRole('button', { name: 'Save note' }).click();
    await expect.poll(() => popover.count()).toBe(0);
    await expect.poll(() => highlights.count()).toBe(before + 1);
    await highlights.last().click();
    await expect
      .poll(() => page.locator('.annot-popover textarea').inputValue())
      .toBe('Your guess: a model / Paper: Transformer: an attention-based sequence model.');
    expect(await page.locator('.annot-popover-snippet').textContent()).toBe('transformer');
    await shot(page, 'reader-define-saved-note');
    await page.close();
  });

  it('pinch-zooms as a GPU stretch and lays out once, at the end, around the cursor', async () => {
    const page = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(pdfUrl)}`);
    await page.waitForSelector('.reader-page[aria-label^="Page 1 "] .reader-canvas[data-ready]');
    const box = (await page.locator('.reader-viewport').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 3;
    // Where the cursor sits on page 1, as fractions of its on-screen rect.
    const spot = () =>
      page.evaluate(
        ([x, y]) => {
          const r = document.querySelector('.reader-page[aria-label^="Page 1 "]')!.getBoundingClientRect();
          return { fx: (x - r.left) / r.width, fy: (y - r.top) / r.height };
        },
        [cx, cy],
      );
    const width = () =>
      page.$eval('.reader-page[aria-label^="Page 1 "]', (el) => (el as HTMLElement).offsetWidth);
    const w0 = await width();
    const before = await spot();

    await page.mouse.move(cx, cy);
    await page.keyboard.down('Control');
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -20);

    // Mid-gesture: stretched by a transform, with no layout yet.
    expect(await page.$eval('.reader-page-list', (el) => (el as HTMLElement).style.transform)).toMatch(/scale/);
    expect(await width()).toBe(w0);
    const during = await spot();
    expect(during.fx).toBeCloseTo(before.fx, 2);
    expect(during.fy).toBeCloseTo(before.fy, 2);

    await page.keyboard.up('Control');
    // Gesture over: real layout at the new zoom, the transform gone, the spot still under the cursor.
    await expect.poll(width).toBeGreaterThan(w0 * 1.5);
    expect(await page.$eval('.reader-page-list', (el) => (el as HTMLElement).style.transform)).toBe('');
    const after = await spot();
    expect(after.fx).toBeCloseTo(before.fx, 2);
    expect(after.fy).toBeCloseTo(before.fy, 2);
    await page.close();
  });

  it('paints scanned (CCITT) pages instead of leaving them blank', async () => {
    const src = `${ext.sites.origin('papers')}/scanned.pdf`;
    const page = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(src)}`);
    await page.waitForSelector('[aria-label^="Page 1 of"] canvas');
    // The image covers the page, so its centre is black once it decodes.
    const centre = () =>
      page.$eval('[aria-label^="Page 1 of"] canvas', (c) => {
        const canvas = c as HTMLCanvasElement;
        const ctx = canvas.getContext('2d')!;
        return Array.from(ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data.slice(0, 3));
      });
    await expect.poll(centre, { timeout: 10_000 }).toEqual([0, 0, 0]);
  });

  it('opens a PDF from this computer in the reader instead of Chrome\'s viewer', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'reader-local-')), 'local paper.pdf');
    writeFileSync(file, makePdf(2));
    const url = pathToFileURL(file).href;
    const page = await ext.ctx.newPage();
    await page.goto(url).catch(() => undefined); // the redirect aborts this navigation
    await page.waitForURL((u) => u.protocol === 'chrome-extension:', { timeout: 10_000 });
    expect(new URL(page.url()).searchParams.get('src')).toBe(url);
    await page.waitForSelector('[aria-label="Page 1 of 2"] .textLayer span', { timeout: 10_000 });
  });

  it('opens an arXiv PDF in the reader, with alphaXiv one menu item away', async () => {
    const pdf = makePdf(1);
    await ext.ctx.route('https://arxiv.org/pdf/**', (r) => r.fulfill({ contentType: 'application/pdf', body: pdf }));
    await ext.ctx.route('https://www.alphaxiv.org/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>alphaXiv</title>' }));
    const page = await ext.ctx.newPage();
    await page.goto('https://arxiv.org/pdf/1706.03762').catch(() => undefined); // the redirect aborts this navigation
    await page.waitForURL((u) => u.protocol === 'chrome-extension:', { timeout: 10_000 });
    await page.waitForSelector('[aria-label="Page 1 of 1"]');

    await page.getByRole('button', { name: 'More reader options' }).click();
    await page.getByRole('menuitem', { name: 'Open in alphaXiv' }).click();
    await page.waitForURL('https://www.alphaxiv.org/abs/1706.03762');

    // Not an arXiv paper: no alphaXiv item.
    const other = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(pdfUrl)}`);
    await other.waitForSelector('[aria-label^="Page 1 of"]');
    await other.getByRole('button', { name: 'More reader options' }).click();
    await other.getByRole('menuitem', { name: /Open in Chrome/ }).waitFor();
    expect(await other.getByRole('menuitem', { name: 'Open in alphaXiv' }).count()).toBe(0);
  });

  it('defines an Option/Alt-clicked word on any web page', async () => {
    ext.sites.setRoute('blog', '/post', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html lang="en"><head><title>post</title></head><body>` +
          `<p id="para">${LINE}</p><p><a id="link" href="/elsewhere">the transformer paper</a></p></body></html>`,
      );
    });
    const page = await ext.ctx.newPage();
    await page.goto(`${ext.sites.origin('blog')}/post`);
    const centreOf = (selector: string) =>
      page.$eval(selector, (el) => {
        const node = el.firstChild as Text;
        const start = node.data.indexOf('transformer');
        const range = document.createRange();
        range.setStart(node, start + 3);
        range.setEnd(node, start + 4);
        const r = range.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
    const altClick = async (at: { x: number; y: number }) => {
      await page.keyboard.down('Alt');
      await page.mouse.click(at.x, at.y);
      await page.keyboard.up('Alt');
    };
    const card = () => page.frames().find((f) => f.url().includes('/src/pages/define/'));

    // A plain click defines nothing.
    await page.mouse.click((await centreOf('#para')).x, (await centreOf('#para')).y);
    await page.waitForTimeout(300);
    expect(card()).toBeUndefined();

    // Registered at install, so this page (loaded after) already has the script.
    await altClick(await centreOf('#para'));
    await expect.poll(() => Boolean(card()), { timeout: 10_000 }).toBe(true);
    const frame = card()!;
    expect(new URL(frame.url()).searchParams.get('word')).toBe('transformer');
    await frame.waitForFunction(() => document.body.textContent?.includes('attention-based sequence model'), null, {
      timeout: 10_000,
    });
    // The answer renders as markdown, as in the reader: the bold is bold, not asterisks.
    await frame.waitForSelector('strong', { timeout: 5_000 });
    // The frame fits its answer: one short line plus the provenance, not the loading height.
    const box = await (await frame.frameElement()).boundingBox();
    const contentHeight = await frame.evaluate(() => document.body.getBoundingClientRect().height);
    await expect.poll(async () => Math.abs((await (await frame.frameElement()).boundingBox())!.height - contentHeight)).toBeLessThan(2);
    expect(box).not.toBeNull();
    await shot(page, 'web-define');

    // Esc puts it away.
    await page.keyboard.press('Escape');
    await expect.poll(() => Boolean(card())).toBe(false);

    // Alt-clicking a word in a link defines it instead of following (or downloading) the link.
    await altClick(await centreOf('#link'));
    await expect.poll(() => Boolean(card())).toBe(true);
    expect(new URL(page.url()).pathname).toBe('/post');

    // Once written, the card asks to keep the definition as a note on this page. Declined: nothing stored.
    const linkCard = card()!;
    await linkCard.getByRole('button', { name: 'No', exact: true }).click({ timeout: 10_000 });
    expect(await linkCard.getByText('Save as a note here?').count()).toBe(0);
    await page.mouse.click(5, 5);
    await expect.poll(() => Boolean(card())).toBe(false);
    const noteFor = async () =>
      (await storage<Annotation[]>(ext, 'annotations')).find((a) => a.docUrl === page.url());
    expect(await noteFor()).toBeUndefined();

    // Accepted: a highlight on the word, anchored by its quote, with the definition as the note.
    await altClick(await centreOf('#para'));
    await expect.poll(() => Boolean(card()), { timeout: 10_000 }).toBe(true);
    await card()!.getByRole('button', { name: 'Save note' }).click({ timeout: 10_000 });
    await expect.poll(() => Boolean(card())).toBe(false);
    await expect.poll(noteFor).toMatchObject({
      kind: 'highlight',
      text: 'transformer',
      note: 'Transformer: an attention-based sequence model.',
      anchor: { kind: 'text', quote: 'transformer', prefix: 'The ', suffix: ' reads a sentence and BLEU score' },
    });
  });
});
