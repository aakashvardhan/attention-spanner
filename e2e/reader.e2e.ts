import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGES, axe, expectClean, launch, mockClaude, seed, shot, storage, type Ext } from './harness';

/**
 * The PDF reader end to end against a scripted Claude: a clicked term guessed
 * then defined in place, the reading session that blocks distracting sites
 * while the reader is open, and the PDF plumbing (zoom, scans, arXiv). Model
 * output is fixed, so this checks the wiring, not the model.
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

describe('reader: key terms, reading session, PDF plumbing', () => {
  let ext: Ext;
  let claude: Awaited<ReturnType<typeof mockClaude>>;
  let pdfUrl: string;

  beforeAll(async () => {
    ext = await launch();
    claude = await mockClaude(ext, (system, prompt) =>
      !system.includes('clicked')
        ? 'Unexpected call.'
        : prompt.includes('BLEU')
          ? '**BLEU**: a precision score, $\\text{BP}\\cdot\\exp(\\sum_n w_n \\log p_n)$.'
          : '**Transformer**: an attention-based sequence model.',
    );
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
    ext.sites.setRoute('blockme', '/', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>distraction</title><p>distraction</p>');
    });
    await seed(ext, { settings: { claudeKey: 'sk-e2e', focusBlocklist: ['blockme.e2e.test'] } });
  });

  afterAll(async () => {
    await ext?.close();
  });

  it('asks for a guess before defining, and Haiku defines the term', async () => {
    const page = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(pdfUrl)}`);
    await page.waitForSelector('[aria-label^="Page 1 of"] .textLayer span');

    // One walnut room: the page behind the paper is --bg-page.
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(28, 20, 16)');

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
    const asked = claude.find((c) => c.system.includes('clicked'));
    expect(asked?.model).toBe('claude-haiku-5-5');
    await shot(page, 'reader-walnut-define');

    // A click elsewhere closes it.
    await page.mouse.click(5, 300);
    await expect.poll(() => popover.count()).toBe(0);

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

  it('draws the maths in a definition with KaTeX, loaded on first use', async () => {
    const page = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(pdfUrl)}`);
    await page.waitForSelector('[aria-label^="Page 1 of"] .textLayer span');
    const at = await page.$eval('.reader-page[aria-label^="Page 1 "] .textLayer span', (span) => {
      const node = span.firstChild as Text;
      const start = node.data.indexOf('BLEU');
      const range = document.createRange();
      range.setStart(node, start + 1);
      range.setEnd(node, start + 2);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(at.x, at.y);
    const popover = page.getByRole('dialog', { name: 'Definition of BLEU' });
    await popover.getByRole('textbox').fill('a score');
    await popover.getByRole('button', { name: 'Compare' }).click();
    await expect.poll(() => popover.locator('.md .katex').count(), { timeout: 10_000 }).toBe(1);
    expect(await popover.locator('.md').textContent()).not.toContain('$');
    // The term is bold; the formula's own glyphs came with KaTeX's fonts.
    expect(await popover.locator('.md strong').textContent()).toBe('BLEU');
    expect(await page.evaluate(() => document.fonts.check('16px KaTeX_Main'))).toBe(true);
    expect(await axe(page)).toEqual([]);
    await page.close();
    expectClean(ext);
  });

  it('highlights a selection, keeps a note on it, pins a sticky note, and lists both under Notes', async () => {
    type Stored = { id: string; kind: string; color: string; text: string; note: string };
    const all = async () => (await storage<Stored[]>(ext, 'annotations')) ?? [];
    const page = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(pdfUrl)}`);
    await page.waitForSelector('[aria-label^="Page 1 of"] .textLayer span');
    const before = (await all()).length;

    // Select the first line; releasing the pointer offers the colours.
    await page.evaluate(() => {
      const span = document.querySelector('.reader-page[aria-label^="Page 1 "] .textLayer span')!;
      const range = document.createRange();
      range.selectNodeContents(span);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      document.querySelector('.reader-viewport')!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    const menu = page.getByRole('toolbar', { name: 'Highlight colour' });
    await menu.getByRole('button', { name: 'Highlight in green' }).click();
    await expect.poll(() => menu.count()).toBe(0);
    await expect.poll(async () => (await all()).length).toBe(before + 1);
    const highlight = (await all()).at(-1)!;
    expect(highlight).toMatchObject({ kind: 'highlight', color: 'green' });
    expect(highlight.text).toContain('transformer');

    // Its note is kept when a click elsewhere closes the popover (commit on unmount).
    // The green one (an earlier test leaves a yellow highlight on this page).
    await page.locator('.reader-page[aria-label^="Page 1 "] .annot-highlight[style*="129, 199, 132"]').first().click();
    await page.locator('.annot-popover textarea').fill('the key claim');
    await page.mouse.click(5, 300);
    await expect.poll(() => page.locator('.annot-popover').count()).toBe(0);
    await expect.poll(async () => (await all()).find((a) => a.id === highlight.id)?.note).toBe('the key claim');

    // A sticky note: note mode, a click on the page, then Cmd/Ctrl+Enter saves and closes.
    await page.mouse.move(400, 10);
    await page.getByRole('button', { name: 'Add a note' }).click();
    const pageBox = (await page.locator('.reader-page[aria-label^="Page 1 "]').boundingBox())!;
    await page.mouse.click(pageBox.x + pageBox.width * 0.8, pageBox.y + pageBox.height * 0.5);
    await expect.poll(() => page.locator('.annot-pin').count()).toBe(1);
    await page.locator('.annot-popover textarea').fill('ask about the baseline');
    await page.keyboard.press('Control+Enter');
    await expect.poll(() => page.locator('.annot-popover').count()).toBe(0);
    await expect.poll(async () => (await all()).find((a) => a.kind === 'sticky')?.note).toBe('ask about the baseline');

    // Both are listed on page 1; deleting the highlight from the list removes it everywhere.
    await page.mouse.move(400, 10);
    await page.getByRole('button', { name: /^Show highlights and notes/ }).click();
    const notes = page.locator('.reader-notes');
    await expect.poll(() => notes.locator('h3').first().textContent()).toBe('Page 1');
    await expect.poll(() => notes.textContent()).toContain('ask about the baseline');
    expect(await notes.textContent()).toContain('the key claim');
    await shot(page, 'reader-notes');
    expect(await axe(page)).toEqual([]);
    // The delete mark shows on hover only (mouse-only today; see rust/NOTES.md, phase 4b).
    const row = notes.locator('.annot-row', { hasText: 'the key claim' });
    await row.hover();
    await row.locator('.annot-row-delete').click();
    await expect.poll(async () => (await all()).some((a) => a.id === highlight.id)).toBe(false);
    await expect.poll(() => notes.textContent()).not.toContain('the key claim');
    await page.close();
    expectClean(ext);
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

  it('leaves a local PDF and a non-arXiv web PDF in Chrome\'s own viewer', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'reader-local-')), 'local paper.pdf');
    writeFileSync(file, makePdf(2));
    const local = pathToFileURL(file).href;
    const page = await ext.ctx.newPage();
    await page.goto(local).catch(() => undefined);
    await page.waitForTimeout(800);
    expect(page.url()).toBe(local);
    await page.goto(pdfUrl).catch(() => undefined);
    await page.waitForTimeout(800);
    expect(page.url()).toBe(pdfUrl);
    await page.close();
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

  it('blocks the blocklist while a reader tab is open, and lifts it when the reader closes', async () => {
    const blocked = `${ext.sites.origin('blockme')}/`;
    // Earlier tests leave reader tabs open; each would hold the session too.
    for (const p of ext.ctx.pages()) if (p.url().includes('/src/pages/reader/')) await p.close();
    await expect.poll(() => storage(ext, 'focusSession')).toBeNull();
    const reader = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(pdfUrl)}`);
    await reader.waitForSelector('[aria-label^="Page 1 of"]');
    await expect
      .poll(async () => (await storage<{ tabIds: number[] } | null>(ext, 'focusSession'))?.tabIds.length ?? 0)
      .toBe(1);
    // The session is stored before its redirect rules land; wait for the rule itself.
    await expect
      .poll(() => ext.sw.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).some((r) => r.id >= 1000 && r.id < 2000)))
      .toBe(true);

    const other = await ext.ctx.newPage();
    await other.goto(blocked).catch(() => undefined); // the redirect aborts this navigation
    await other.waitForURL((u) => u.pathname.endsWith('/src/pages/blocked/index.html'), { timeout: 10_000 });
    await expect.poll(() => other.locator('h1').innerText()).toContain('is blocked while you read');
    await shot(other, 'reader-session-blocked');

    // "Back to your paper" brings the reader forward.
    await other.getByRole('button', { name: 'Back to your paper' }).click();

    await reader.close();
    await expect.poll(() => storage(ext, 'focusSession')).toBeNull();
    // The blocked tab releases itself, and the site loads again.
    await expect.poll(() => other.locator('h1').innerText()).toBe('Reading session over');
    await other.goto(blocked);
    expect(await other.locator('p').innerText()).toBe('distraction');
    await other.close();
  });
});
