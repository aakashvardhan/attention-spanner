import type { Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PAGES, expectA11y, expectClean, expectScreenshot, launch, mockClaude, seed, settle, shot, storage, type Ext } from './harness';
import { paper } from './seed';

/**
 * The lexicon graph against a scripted Claude: terms drawn as nodes, a click
 * opening the meaning, links found by Haiku, and the layout's motion. Model
 * output is fixed, so this checks the wiring, not the model.
 */

interface Source { docKey: string; paperTitle: string; definition: string; guess: string; context: string; addedAt: number }
interface Term { id: string; label: string; sources: Source[]; linkedAt: number | null }
interface Edge { a: string; b: string; relation: string; why: string; at: number }
interface Lex { terms: Term[]; edges: Edge[] }

const src = (doc: string, definition: string, guess = ''): Source => ({
  docKey: doc,
  paperTitle: `Paper ${doc}`,
  definition,
  guess,
  context: '',
  addedAt: 1,
});
const term = (label: string, sources: Source[], linkedAt: number | null = null): Term => ({
  id: label.toLowerCase(),
  label,
  sources,
  linkedAt,
});

const SEED: Lex = {
  terms: [
    term('Transformer', [src('p1', 'An attention-based sequence model.', 'a model'), src('p2', 'A stack of attention layers.')], 1),
    term('Attention', [src('p1', 'Weights each token by its relevance to a query.')], 1),
    term('BLEU', [src('p1', 'A precision score for translations.')]),
    term('Perplexity', [src('p2', 'How surprised a language model is by text.')]),
  ],
  edges: [{ a: 'transformer', b: 'attention', relation: 'is built from', why: 'Every layer is attention plus a feed-forward block.', at: 1 }],
};

const nodes = (page: Page) => page.locator('.lex-node');
const node = (page: Page, label: string) => page.locator('.lex-node', { hasText: label });

/** Until two samples of every node's place, a few frames apart, agree. */
async function stillness(page: Page, timeout = 8000): Promise<number> {
  const start = Date.now();
  const sample = () => page.$$eval('.lex-node', (els) => els.map((e) => (e as HTMLElement).style.transform).join('|'));
  let last = await sample();
  for (;;) {
    await page.waitForTimeout(250);
    const now = await sample();
    if (now === last) return Date.now() - start;
    if (Date.now() - start > timeout) throw new Error('the graph never came to rest');
    last = now;
  }
}

describe('lexicon: the term graph', () => {
  let ext: Ext;
  let claude: Awaited<ReturnType<typeof mockClaude>>;
  let reply = '[]';

  beforeAll(async () => {
    ext = await launch();
    claude = await mockClaude(ext, () => reply);
  });
  afterAll(async () => ext.close());
  beforeEach(async () => {
    ext.errors.splice(0);
    claude.splice(0);
    await seed(ext, { settings: { claudeKey: 'sk-e2e' }, lexicon: SEED });
  });

  it('says how to start when nothing is kept yet', async () => {
    await seed(ext, { lexicon: { terms: [], edges: [] } });
    const page = await ext.page(PAGES.lexicon);
    await expect.poll(() => page.getByText('Your lexicon is empty').count()).toBe(1);
    expect(await page.getByRole('button', { name: 'Find links', exact: true }).isDisabled()).toBe(true);
    await expectA11y(page, 'lexicon');
    await page.close();
    expectClean(ext);
  });

  it('draws terms as nodes and links as lines, and opens a meaning on click', async () => {
    const page = await ext.page(PAGES.lexicon);
    await expect.poll(() => nodes(page).count()).toBe(4);
    expect(await page.locator('.lex-edge-line').count()).toBe(1);
    expect(await page.locator('.lex-count').textContent()).toBe('4 terms · 1 link');
    // Not linked yet: drawn hollow.
    expect(await page.locator('.lex-node.is-fresh').count()).toBe(2);
    await stillness(page);

    await node(page, 'Transformer').click();
    const pop = page.getByRole('dialog', { name: 'Transformer: meaning and links' });
    await expect.poll(() => pop.count()).toBe(1);
    // One meaning per paper, the reader's own guess beside it.
    expect(await pop.locator('.lex-source').count()).toBe(2);
    expect(await pop.textContent()).toContain('An attention-based sequence model.');
    expect(await pop.textContent()).toContain('Your guess: a model');
    expect(await pop.getByRole('link', { name: 'Open paper ↗' }).count()).toBe(0);
    expect(await pop.getByRole('button', { name: /is built from/ }).textContent()).toContain('Attention');
    await settle(page);
    await shot(page, 'lexicon-open');

    // A link chip moves to the other term.
    await pop.getByRole('button', { name: /is built from/ }).click();
    await expect.poll(() => page.getByRole('dialog', { name: 'Attention: meaning and links' }).count()).toBe(1);
    expect(await page.getByRole('button', { name: 'Fit' }).isDisabled()).toBe(false);
    await expectA11y(page, 'lexicon');

    // A click on the empty stage puts it away.
    await page.mouse.click(10, 860);
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    await page.close();
    expectClean(ext);
  });

  it('works from the keyboard: Tab to a term, Enter opens it, Escape returns focus', async () => {
    const page = await ext.page(PAGES.lexicon);
    await expect.poll(() => nodes(page).count()).toBe(4);
    await nodes(page).first().focus();
    await page.keyboard.press('Enter');
    const pop = page.getByRole('dialog');
    await expect.poll(() => pop.count()).toBe(1);
    expect(await nodes(page).first().getAttribute('aria-expanded')).toBe('true');
    await page.keyboard.press('Escape');
    await expect.poll(() => pop.count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.classList.contains('lex-node'))).toBe(true);
    expect(await nodes(page).first().getAttribute('aria-label')).toMatch(/, 1 link$/);
    await page.close();
    expectClean(ext);
  });

  it('shows the original passage and resolves the source through the paper library', async () => {
    const source = {
      ...src('arxiv:2601.00001', 'An attention-based sequence model.'),
      context: 'We use a transformer to translate the input sentence.',
    };
    await seed(ext, {
      papers: [paper('1', 'The source paper')],
      lexicon: { terms: [term('Transformer', [source])], edges: [] },
    });
    const page = await ext.page(PAGES.lexicon);
    await node(page, 'Transformer').click();
    const pop = page.getByRole('dialog', { name: 'Transformer: meaning and links' });
    expect(await pop.locator('.lex-context').textContent()).toBe(source.context);
    await expect.poll(() => pop.getByRole('link', { name: 'Open paper ↗' }).getAttribute('href')).toBe(
      `chrome-extension://${ext.id}/${PAGES.reader}?src=${encodeURIComponent('https://arxiv.org/pdf/2601.00001')}`,
    );
    await expectA11y(page, 'lexicon');
    await shot(page, 'lexicon-source');
    await page.close();
    expectClean(ext);
  });

  it('deletes a term and its links, after asking', async () => {
    const page = await ext.page(PAGES.lexicon);
    await expect.poll(() => nodes(page).count()).toBe(4);
    await node(page, 'Attention').click();
    const pop = page.getByRole('dialog', { name: 'Attention: meaning and links' });
    await pop.getByRole('button', { name: 'Delete term' }).click();
    await pop.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => nodes(page).count()).toBe(3);
    const lex = await storage<Lex>(ext, 'lexicon');
    expect(lex.terms.map((t) => t.id)).not.toContain('attention');
    expect(lex.edges).toEqual([]);
    expect(await page.locator('.lex-edge-line').count()).toBe(0);
    await page.close();
    expectClean(ext);
  });

  it('finds links with Haiku, keeping only links between real terms', async () => {
    reply =
      'Here are the links:\n```json\n[' +
      '{"a":"bleu","b":"perplexity","relation":"contrasts with","why":"One scores outputs, the other the model."},' +
      '{"a":"bleu","b":"ghost","relation":"is","why":"x"},' +
      '{"a":"perplexity","b":"bleu","relation":"again","why":"x"},' +
      '{"a":"transformer","b":"attention","relation":"overwrites?","why":"x"}' +
      ']\n```';
    const page = await ext.page(PAGES.lexicon);
    const find = page.getByRole('button', { name: 'Find links (2 new)' });
    await find.click();
    await expect.poll(() => page.locator('.lex-status').textContent(), { timeout: 10_000 }).toBe('Found 1 new link.');
    expect(claude.length).toBe(1);
    expect(claude[0].model).toBe('claude-haiku-5-5');
    expect(claude[0].prompt).toContain('bleu\nperplexity');

    const lex = await storage<Lex>(ext, 'lexicon');
    expect(lex.edges.length).toBe(2);
    expect(lex.edges[0].relation).toBe('is built from');
    expect(lex.edges[1]).toMatchObject({ a: 'bleu', b: 'perplexity', relation: 'contrasts with' });
    expect(lex.terms.every((t) => t.linkedAt !== null)).toBe(true);
    await expect.poll(() => page.locator('.lex-edge-line').count()).toBe(2);
    expect(await page.getByRole('button', { name: 'All linked' }).isDisabled()).toBe(true);

    // The new link opens with its reason.
    await page.locator('.lex-edge-hit').nth(1).dispatchEvent('click');
    const pop = page.getByRole('dialog', { name: 'Link' });
    expect(await pop.textContent()).toContain('One scores outputs, the other the model.');
    await pop.getByRole('button', { name: 'Remove link' }).click();
    await expect.poll(async () => (await storage<Lex>(ext, 'lexicon')).edges.length).toBe(1);
    await page.close();
    expectClean(ext);
  });

  it('leaves the lexicon alone when the reply cannot be read, or there is no key', async () => {
    reply = 'I cannot help with that.';
    const page = await ext.page(PAGES.lexicon);
    await page.getByRole('button', { name: 'Find links (2 new)' }).click();
    await expect.poll(() => page.locator('.lex-status').textContent(), { timeout: 10_000 }).toBe("Claude's links could not be read. Try again.");
    expect(await storage<Lex>(ext, 'lexicon')).toEqual(SEED);

    await seed(ext, { settings: { claudeKey: '' } });
    claude.splice(0);
    await page.getByRole('button', { name: 'Find links (2 new)' }).click();
    await expect.poll(() => page.locator('.lex-status').textContent()).toBe('Add a Claude API key in Settings.');
    expect(claude.length).toBe(0);
    expect(await storage<Lex>(ext, 'lexicon')).toEqual(SEED);
    await page.close();
    expectClean(ext);
  });

  it('gives no link to a term deleted while Haiku was answering', async () => {
    reply = '[{"a":"bleu","b":"perplexity","relation":"contrasts with","why":"x"}]';
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Held until the term is gone, then answered by the scripted Claude.
    await ext.ctx.route('https://api.anthropic.com/**', async (route) => {
      await gate;
      await route.fallback();
    });
    const page = await ext.page(PAGES.lexicon);
    await page.getByRole('button', { name: 'Find links (2 new)' }).click();
    await expect.poll(() => page.getByRole('button', { name: 'Finding links…' }).count()).toBe(1);
    const lex = structuredClone(SEED);
    lex.terms = lex.terms.filter((t) => t.id !== 'perplexity');
    await seed(ext, { lexicon: lex });
    await expect.poll(() => nodes(page).count()).toBe(3);
    release();
    await expect.poll(() => page.locator('.lex-status').textContent(), { timeout: 10_000 }).toBe('No new links this time.');
    const after = await storage<Lex>(ext, 'lexicon');
    expect(after.edges.length).toBe(1);
    expect(after.terms.map((t) => t.id)).not.toContain('perplexity');
    await ext.ctx.unroute('https://api.anthropic.com/**');
    claude = await mockClaude(ext, () => reply);
    await page.close();
    expectClean(ext);
  });

  it('follows another tab, and drags, pans and fits', async () => {
    const page = await ext.page(PAGES.lexicon);
    await expect.poll(() => nodes(page).count()).toBe(4);
    await stillness(page);

    // A term kept in the reader appears without a reload.
    const more = structuredClone(SEED);
    more.terms.push(term('Tokenizer', [src('p3', 'Splits text into tokens.')]));
    await seed(ext, { lexicon: more });
    await expect.poll(() => nodes(page).count()).toBe(5);
    await stillness(page);

    // Dragging a node moves it and does not open it.
    const box = (await node(page, 'BLEU').boundingBox())!;
    const before = await node(page, 'BLEU').evaluate((e) => (e as HTMLElement).style.transform);
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 60, { steps: 8 });
    await page.mouse.up();
    expect(await node(page, 'BLEU').evaluate((e) => (e as HTMLElement).style.transform)).not.toBe(before);
    expect(await page.getByRole('dialog').count()).toBe(0);
    await stillness(page);

    // Grabbing a node stops the camera following the graph, so the node stays under the pointer; Fit brings it back.
    const fit = page.getByRole('button', { name: 'Fit' });
    expect(await fit.isDisabled()).toBe(false);
    await fit.click();
    expect(await fit.isDisabled()).toBe(true);

    // Panning the empty stage moves everything and leaves Fit on offer.
    const panned = await node(page, 'BLEU').evaluate((e) => (e as HTMLElement).style.transform);
    await page.mouse.move(20, 860);
    await page.mouse.down();
    await page.mouse.move(220, 760, { steps: 6 });
    await page.mouse.up();
    expect(await fit.isDisabled()).toBe(false);
    expect(await node(page, 'BLEU').evaluate((e) => (e as HTMLElement).style.transform)).not.toBe(panned);
    await fit.click();
    expect(await fit.isDisabled()).toBe(true);
    await page.close();
    expectClean(ext);
  });

  it('settles a 300-term lexicon in a few seconds', async () => {
    const big: Lex = {
      terms: Array.from({ length: 300 }, (_, i) => term(`Term ${i}`, [src('p1', `Meaning ${i}.`)], 1)),
      edges: Array.from({ length: 299 }, (_, i) => ({ a: `term ${i}`, b: `term ${(i * 7 + 1) % 300}`, relation: 'r', why: '', at: 1 })).filter(
        (e) => e.a !== e.b,
      ),
    };
    await seed(ext, { lexicon: big });
    const page = await ext.page(PAGES.lexicon);
    await expect.poll(() => nodes(page).count()).toBe(300);
    expect(await stillness(page, 10_000)).toBeLessThan(8000);
    await page.close();
    expectClean(ext);
  });

  it('looks the same as last time (reduced motion: drawn at rest)', async () => {
    const page = await ext.ctx.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`chrome-extension://${ext.id}/${PAGES.lexicon}`);
    await expect.poll(() => nodes(page).count()).toBe(4);
    await expectScreenshot(page, 'lexicon-graph');
    await page.close();
    expectClean(ext);
  });
});
