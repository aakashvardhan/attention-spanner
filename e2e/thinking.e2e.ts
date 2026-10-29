import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Annotation, Provocation } from '../src/shared/types';
import { PAGES, launch, seed, shot, storage, type Ext } from './harness';
import { deck, paper } from './seed';

/**
 * The PDF reader asks instead of answering: a tagged highlight draws a
 * counterpoint to the reader's own reason, and pass 3 pauses scrolling on a
 * page until it is justified (or honestly left open).
 */

const LINE = 'The transformer reads a sentence and BLEU scores the translation it writes back out.';

/** A minimal valid PDF: each page holds a few lines of plain Helvetica text (as in reader.e2e.ts). */
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

/** Ollama's health check and a streaming /api/chat: a counterpoint for the reasoning check, NONE otherwise. */
async function startChatMock() {
  const chats: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'mock' }] }));
      if (req.url === '/api/show') return res.end('{}');
      if (req.url === '/api/chat') {
        const { messages } = JSON.parse(body) as { messages: { content: string }[] };
        const system = messages[0].content;
        chats.push(system);
        const reply = system.includes('reasoning')
          ? 'Q: Would it hold if only λ changed?\nGap: a confounded comparison.'
          : 'NONE';
        res.setHeader('content-type', 'application/x-ndjson');
        res.end(JSON.stringify({ message: { content: reply }, done: true }) + '\n');
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

describe('reader: provocations', () => {
  let ext: Ext;
  let ollama: Awaited<ReturnType<typeof startChatMock>>;
  let pdfUrl: string;

  beforeAll(async () => {
    ext = await launch();
    ollama = await startChatMock();
    const pdf = makePdf(4);
    ext.sites.setRoute('papers', '/thinking.pdf', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(pdf);
    });
    pdfUrl = `${ext.sites.origin('papers')}/thinking.pdf`;
  });

  afterAll(async () => {
    await ext?.close();
    await ollama?.close();
  });

  it('tagging a highlight Doubt with a reason draws a counterpoint; Revise stores 15 XP', async () => {
    await seed(ext, { settings: { ollamaUrl: ollama.url, ollamaChatModel: 'mock', layaUrl: '', cloudMode: 'off' } });
    const page = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(pdfUrl)}`);
    await page.waitForSelector('[aria-label^="Page 1 of"] .textLayer span');

    // Select "BLEU scores" in the first line, as a drag would.
    await page.$eval('.reader-page[aria-label^="Page 1 "] .textLayer span', (span) => {
      const node = span.firstChild as Text;
      const start = node.data.indexOf('BLEU scores');
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 'BLEU scores'.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      span.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await page.getByRole('toolbar', { name: 'Highlight as' }).getByRole('button', { name: 'Doubt' }).click();

    const card = page.locator('.provoke-margin');
    await card.getByRole('textbox', { name: 'Your answer' }).fill('BLEU is only one metric');
    await card.getByRole('button', { name: 'Save reason' }).click();
    await expect
      .poll(async () => (await storage<Annotation[]>(ext, 'annotations')).find((a) => a.text === 'BLEU scores'))
      .toMatchObject({ tag: 'doubt', color: 'pink', note: 'BLEU is only one metric' });

    const counter = page.getByRole('region', { name: 'Counterpoint' });
    await expect.poll(() => counter.textContent(), { timeout: 10_000 }).toContain('Would it hold if only λ changed?');
    expect(await counter.textContent()).toContain('a confounded comparison.');
    await shot(page, 'reader-counterpoint');
    await counter.getByRole('textbox', { name: 'Your reply' }).fill('Fair, it needs a second metric');
    await counter.getByRole('button', { name: 'Revise' }).click();
    await expect
      .poll(async () => (await storage<Provocation[]>(ext, 'provocations')).find((p) => p.kind === 'counterpoint'))
      .toMatchObject({ status: 'answered', response: 'revised', xp: 15, answer: 'Fair, it needs a second metric' });
    await page.close();
  });

  it('untracked PDF, pass 3, AI off: the first page locks with the fallback, scrolling stays on page 1, "I don\'t know yet" unlocks and shows Open questions 1', async () => {
    await seed(ext, { settings: { ollamaUrl: ollama.url, ollamaChatModel: '', layaUrl: '', cloudMode: 'off' } });
    const page = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(pdfUrl)}`);
    await page.waitForSelector('[aria-label^="Page 1 of"] .textLayer span');

    await page.getByRole('radio', { name: 'Pass 3' }).click();
    const lock = page.getByRole('dialog', { name: 'Scrolling paused' });
    await expect.poll(() => lock.textContent()).toContain('What would have to be true for this page’s claim to hold');
    await shot(page, 'reader-pass-lock');

    // Forward scrolling is clamped to page 1.
    const viewport = page.locator('.reader-viewport');
    await viewport.evaluate((el) => {
      const third = el.querySelector<HTMLElement>('.reader-page[aria-label^="Page 3 "]')!;
      el.scrollTop = third.offsetTop;
    });
    await page.waitForTimeout(300);
    const centrePage = () =>
      viewport.evaluate((el) => {
        const mid = el.scrollTop + el.clientHeight / 2;
        const pages = [...el.querySelectorAll<HTMLElement>('.reader-page')];
        return pages.findIndex((p) => p.offsetTop <= mid && mid < p.offsetTop + p.offsetHeight) + 1;
      });
    expect(await centrePage()).toBe(1);

    await lock.getByRole('button', { name: "I don't know yet" }).click();
    await expect.poll(() => lock.count()).toBe(0);
    await expect.poll(() => page.getByRole('button', { name: /Open questions 1/ }).count()).toBe(1);
    const stored = (await storage<Provocation[]>(ext, 'provocations')).filter((p) => p.kind === 'lock');
    expect(stored).toMatchObject([{ status: 'unsure', page: 1, paperId: null }]);

    // Unlocked, it scrolls on.
    await viewport.evaluate((el) => {
      const third = el.querySelector<HTMLElement>('.reader-page[aria-label^="Page 3 "]')!;
      el.scrollTop = third.offsetTop;
    });
    await expect.poll(centrePage).toBeGreaterThan(1);
    await page.close();
  });

  it('deck shows claims, doubts and open questions; answering today\'s question gives 10 XP', async () => {
    const now = Date.now();
    const hl = (id: string, tag: 'claim' | 'doubt', page: number, text: string, note: string): Annotation => ({
      id, tag, docKey: 'k', docUrl: pdfUrl, paperId: 'p1', kind: 'highlight', text, note, createdAt: now, updatedAt: now,
      color: tag === 'claim' ? 'blue' : 'pink',
      anchor: { kind: 'pdf', page, rects: [], x: 0, y: 0 },
    });
    const open: Provocation = {
      id: 'v1', docKey: 'k', paperId: 'p1', page: 6, kind: 'equation', question: 'Why does the loss need a square root?',
      answer: '', status: 'open', annotationId: null, xp: 0, createdAt: now, updatedAt: now,
    };
    await seed(ext, {
      decks: [deck],
      papers: [paper('1', 'Attention Is All You Need', { id: 'p1', verdict: 'Convincing on translation only.', pass: 2 })],
      annotations: [hl('a1', 'claim', 3, 'Self-attention beats recurrence', 'p3 note'), hl('a2', 'doubt', 4, 'BLEU is enough', 'weak metric')],
      provocations: [open],
    });
    const page = await ext.page(`${PAGES.papers}#deck=e2e-deck`);
    await page.getByRole('button', { name: 'Details' }).click();
    const record = page.locator('.pp-record');
    await expect.poll(() => record.textContent()).toContain('Self-attention beats recurrence');
    const text = (await record.textContent()) ?? '';
    expect(text).toContain('BLEU is enough');
    expect(text).toContain('Why does the loss need a square root?');
    expect(text).toContain('Convincing on translation only.');
    expect(text).toContain('1 still open');
    const card = page.locator('.pp-today');
    expect(await card.textContent()).toContain('Why does the loss need a square root?');
    await shot(page, 'deck-record');

    await card.getByRole('textbox').fill('It keeps units consistent');
    await card.getByRole('button', { name: 'Answer in one line' }).click();
    await expect.poll(() => page.locator('.pp-deck-head').textContent()).toContain('10 XP');
    await expect.poll(() => record.textContent()).not.toContain('still open');
    await page.close();
  });
});
