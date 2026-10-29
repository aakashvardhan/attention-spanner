import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { annotationDocKey } from '../src/shared/annotations';
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
    expect(await counter.textContent()).toContain('Counterpoint · to your doubt');
    // The card sits off its anchor: it does not overlap the highlighted line.
    const overlap = await page.evaluate(() => {
      const c = document.querySelector('.provoke-margin')!.getBoundingClientRect();
      return [...document.querySelectorAll('.annot-highlight')].some((el) => {
        const h = el.getBoundingClientRect();
        return c.left < h.right && h.left < c.right && c.top < h.bottom && h.top < c.bottom;
      });
    });
    expect(overlap).toBe(false);
    await shot(page, 'reader-counterpoint');
    await counter.getByRole('textbox', { name: 'Your reply' }).fill('Fair, it needs a second metric');
    await counter.getByRole('button', { name: 'Revise' }).click();
    await expect
      .poll(async () => (await storage<Provocation[]>(ext, 'provocations')).find((p) => p.kind === 'counterpoint'))
      .toMatchObject({ status: 'answered', response: 'revised', xp: 15, answer: 'Fair, it needs a second metric' });
    // The revision replaces the reason on the highlight.
    await expect
      .poll(async () => (await storage<Annotation[]>(ext, 'annotations')).find((a) => a.text === 'BLEU scores')?.note)
      .toBe('Fair, it needs a second metric');
    await page.close();
  });

  /** Opens the PDF in pass 3 with AI off, on page 1. */
  async function openPass3(provocations: Provocation[] = []) {
    await seed(ext, {
      settings: { ollamaUrl: ollama.url, ollamaChatModel: '', layaUrl: '', cloudMode: 'off' },
      provocations,
    });
    const page = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(pdfUrl)}`);
    await page.waitForSelector('[aria-label^="Page 1 of"] .textLayer span');
    await page.getByRole('radio', { name: 'Pass 3' }).click();
    const viewport = page.locator('.reader-viewport');
    const toPage = (n: number) =>
      viewport.evaluate((el, n) => {
        el.scrollTop = el.querySelector<HTMLElement>(`.reader-page[aria-label^="Page ${n} "]`)!.offsetTop;
      }, n);
    const lock = page.getByRole('dialog', { name: 'Scrolling paused' });
    return { page, viewport, toPage, lock };
  }

  const record = (p: Partial<Provocation>): Provocation => ({
    id: 'r1', docKey: annotationDocKey(pdfUrl), paperId: null, page: 1, kind: 'equation', question: 'Why is BLEU enough here?',
    answer: '', status: 'open', annotationId: null, xp: 0, createdAt: Date.now(), updatedAt: Date.now(), ...p,
  });

  it('untracked PDF, pass 3, AI off: page 1 never locks on open; settling into page 2 locks page 1, held at its bottom, going back still scrolls, "I don\'t know yet" unlocks', async () => {
    const { page, viewport, toPage, lock } = await openPass3();
    // Settled on page 1 well past the settle time: no lock on the page you open on.
    await page.waitForTimeout(2000);
    expect(await lock.count()).toBe(0);

    await toPage(2);
    await expect.poll(() => lock.textContent(), { timeout: 5000 }).toContain('What would have to be true for this page’s claim to hold');
    await shot(page, 'reader-pass-lock');

    // Held at page 1's bottom: it is on screen, page 2 is not in the middle.
    const geometry = () =>
      viewport.evaluate((el) => {
        const p1 = el.querySelector<HTMLElement>('.reader-page[aria-label^="Page 1 "]')!;
        return { top: el.scrollTop, mid: el.scrollTop + el.clientHeight / 2, bottom: el.scrollTop + el.clientHeight, p1End: p1.offsetTop + p1.offsetHeight };
      });
    await expect.poll(async () => { const g = await geometry(); return g.mid < g.p1End && g.p1End <= g.bottom; }).toBe(true);
    await toPage(3);
    await page.waitForTimeout(300);
    const held = await geometry();
    expect(held.mid).toBeLessThan(held.p1End);

    // Going back stays possible.
    await viewport.evaluate((el) => (el.scrollTop -= 400));
    await expect.poll(async () => (await geometry()).top).toBeLessThan(held.top);

    await lock.getByRole('button', { name: "I don't know yet" }).click();
    await expect.poll(() => lock.count()).toBe(0);
    await expect.poll(() => page.getByRole('button', { name: /Open questions 1/ }).count()).toBe(1);
    const stored = (await storage<Provocation[]>(ext, 'provocations')).filter((p) => p.kind === 'lock');
    expect(stored).toMatchObject([{ status: 'unsure', page: 1, paperId: null }]);

    // Unlocked, it scrolls on.
    await toPage(3);
    await expect.poll(async () => (await geometry()).mid).toBeGreaterThan(held.p1End);
    await page.close();
  });

  it('pass 3: answering the lock resolves the open record on that page (10 XP), with no extra lock record', async () => {
    const { page, toPage, lock } = await openPass3([record({})]);
    await page.waitForTimeout(1500);
    expect(await lock.count()).toBe(0);
    await toPage(2);
    const field = lock.getByRole('textbox', { name: 'Your answer' });
    await expect.poll(() => field.count(), { timeout: 5000 }).toBe(1);
    await field.fill('The test set shares its domain with training');
    await lock.getByRole('button', { name: 'Continue reading' }).click();
    await expect.poll(() => lock.count()).toBe(0);
    await expect
      .poll(async () => (await storage<Provocation[]>(ext, 'provocations')).find((p) => p.id === 'r1'))
      .toMatchObject({ status: 'answered', xp: 10, answer: 'The test set shares its domain with training' });
    expect((await storage<Provocation[]>(ext, 'provocations')).filter((p) => p.kind === 'lock')).toEqual([]);
    await page.close();
  });

  it('pass 3: a page justified in an earlier session does not lock again on reopen', async () => {
    const { page, toPage, lock } = await openPass3([
      record({ kind: 'lock', status: 'answered', answer: 'It holds on aligned data', question: 'q' }),
    ]);
    await page.waitForTimeout(1500);
    await toPage(2);
    await page.waitForTimeout(2500);
    expect(await lock.count()).toBe(0);
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

    // The verdict edits in place; with no verdict record yet, the save files one (20 XP).
    await record.getByRole('button', { name: 'Convincing on translation only.' }).click();
    const verdict = record.getByRole('textbox', { name: 'Your verdict' });
    await verdict.fill('Convincing on translation, untested elsewhere');
    await verdict.press('Enter');
    await expect
      .poll(async () => (await storage<{ id: string; verdict?: string }[]>(ext, 'papers')).find((p) => p.id === 'p1')?.verdict)
      .toBe('Convincing on translation, untested elsewhere');
    await expect
      .poll(async () => (await storage<Provocation[]>(ext, 'provocations')).filter((p) => p.kind === 'verdict'))
      .toMatchObject([{ paperId: 'p1', status: 'answered', xp: 20, answer: 'Convincing on translation, untested elsewhere' }]);
    await page.close();
  });
});
