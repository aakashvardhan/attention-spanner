import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIST_LIBRARY } from './fixtures/alphaxiv';
import TS_VAULT from './fixtures/ts-vault.json';
import { NETWORK_NOISE, PAGES, expectA11y, expectClean, launch, mockClaude, seed, storage, type Ext } from './harness';
import { paper } from './seed';

/**
 * What the Rust port added, phase by phase: the skeleton, the worker, the
 * brain dump and vault. Kept as regression tests now the port is the build.
 */
describe('rust port: phase 0 skeleton', () => {
  let ext: Ext;
  beforeAll(async () => {
    ext = await launch();
  });
  afterAll(async () => ext?.close());

  it('the worker boots from wasm', async () => {
    expect(await ext.sw.evaluate(() => chrome.runtime.getManifest().name)).toBe('Reader');
    const permissions = await ext.sw.evaluate(() => chrome.runtime.getManifest().permissions);
    expect(permissions).toEqual(['storage', 'alarms', 'declarativeNetRequest', 'identity']);
  });

  it('the new tab override mounts a Leptos page with the shared stylesheets, accessibly', async () => {
    const page = await ext.page(PAGES.newtab);
    await expect.poll(() => page.locator('main.edition .label').first().innerText()).toBeTruthy();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
    expect(await page.title()).toBe('Focus workspace');
    // theme.css loaded: the walnut ground, not the browser's white
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(28, 20, 16)');
    await expectA11y(page, 'newtab');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
});

describe('rust port: phase 2 worker', () => {
  let ext: Ext;
  let page: import('playwright').Page;
  const send = (msg: object) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg) as Promise<Record<string, unknown>>;
  /** Which of our session rules Chrome would apply to a top-level navigation. */
  const matched = (url: string) =>
    ext.sw.evaluate(async (u) => (await chrome.declarativeNetRequest.testMatchOutcome({ url: u, type: 'main_frame' })).matchedRules.map((r) => r.ruleId), url);
  const sessionRules = () => ext.sw.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id));

  beforeAll(async () => {
    ext = await launch();
    page = await ext.page(PAGES.newtab);
  });
  afterAll(async () => ext?.close());

  it('migrates a fresh profile on install', async () => {
    expect(await storage(ext, 'schemaVersion')).toBe(28);
    expect(await storage(ext, 'papers')).toEqual([]);
  });

  it('answers an unknown message with ok: false instead of hanging', async () => {
    expect(await send({ type: 'REFRESH_FEEDS' })).toEqual({ ok: false, error: 'Unknown message.' });
    expect(await send({ type: 'ALPHAXIV_SYNC' })).toEqual({ ok: false, error: 'signed-out' });
  });

  it('installs the arXiv PDF redirect on start and sends arXiv PDFs to the reader', async () => {
    // The reader page lands in phase 4; until then, ask Chrome whether the rule matches.
    expect(await sessionRules()).toContain(3000);
    expect(await matched('https://arxiv.org/pdf/1706.03762')).toEqual([3000]);
    expect(await matched('https://arxiv.org/abs/1706.03762')).toEqual([]);
    expect(await matched('https://example.com/paper.pdf')).toEqual([]);
  });

  it('adds, edits, moves and deletes annotations, refusing bad drafts', async () => {
    const draft = { docKey: 'arxiv:1706.03762', docUrl: 'u', paperId: null, kind: 'sticky', anchor: { kind: 'pdf', page: 1, rects: [], x: 0.1, y: 0.1 }, text: '', color: 'yellow', note: '' };
    const added = (await send({ type: 'ANNOT_ADD', draft })) as { ok: boolean; annotation: { id: string } };
    expect(added.ok).toBe(true);
    const id = added.annotation.id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await send({ type: 'ANNOT_UPDATE', id, patch: { note: 'hi', color: 'green' } })).toEqual({ ok: true });
    expect(await send({ type: 'ANNOT_MOVE', id, x: 0.5, y: 0.6 })).toEqual({ ok: true });
    const [a] = await storage<{ note: string; color: string; anchor: { x: number; y: number } }[]>(ext, 'annotations');
    expect([a.note, a.color, a.anchor.x, a.anchor.y]).toEqual(['hi', 'green', 0.5, 0.6]);
    expect(await send({ type: 'ANNOT_ADD', draft: { ...draft, kind: 'highlight' } })).toEqual({ ok: false, error: 'Highlight has no selection rects.' });
    expect(await send({ type: 'ANNOT_DELETE', id })).toEqual({ ok: true });
    expect(await storage(ext, 'annotations')).toEqual([]);
  });

  it('folds reader progress into a paper and logs the day', async () => {
    await seed(ext, { papers: [paper('1', 'P')], activity: {} });
    const id = '2601.00001';
    expect(await send({ type: 'PAPER_READER_PROGRESS', paperId: id, pdfUrl: 'https://arxiv.org/pdf/2601.00001', page: 5, pageCount: 20, offset: 0.5, leftOff: '3 Method', activeSecondsDelta: 5 })).toEqual({ ok: true });
    const [p] = await storage<{ progressPercent: number; leftOff: string; pdf: { page: number } }[]>(ext, 'papers');
    expect([p.progressPercent, p.leftOff, p.pdf.page]).toEqual([30, '3 Method', 5]); // seeded at 30, 23 does not lower it
    const activity = await storage<Record<string, { papers: string[] }>>(ext, 'activity');
    expect(Object.values(activity)[0].papers).toEqual([id]);
    expect(await send({ type: 'PAPER_READER_PROGRESS', paperId: 'nope', pdfUrl: 'u', page: 1, pageCount: 1, offset: 0, leftOff: '' })).toEqual({ ok: false, error: 'Paper not found.' });
  });

  it('blocks the blocklist while a reader tab holds the session, and lifts it when the tab closes', async () => {
    ext.sites.setRoute('blockme', '/', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>x</title><p>distraction</p>');
    });
    await seed(ext, { settings: { focusBlocklist: ['blockme.e2e.test'] }, focusSession: null, activity: {} });
    const holder = await ext.page(PAGES.newtab);
    expect(await holder.evaluate(() => chrome.runtime.sendMessage({ type: 'READER_OPENED', title: 'A paper' }))).toEqual({ ok: true });
    await expect.poll(async () => (await sessionRules()).includes(1000)).toBe(true);
    expect(await storage<{ title: string }>(ext, 'focusSession')).toMatchObject({ title: 'A paper' });

    // The blocked page lands in phase 3; until then, ask Chrome whether the rule matches.
    expect(await matched(`${ext.sites.origin('blockme')}/`)).toEqual([1000]);
    expect(await matched('https://example.com/')).toEqual([]);

    await holder.close();
    await expect.poll(() => storage(ext, 'focusSession')).toBeNull();
    await expect.poll(async () => (await sessionRules()).includes(1000)).toBe(false);
    expect(await matched(`${ext.sites.origin('blockme')}/`)).toEqual([]);
    const activity = await storage<Record<string, { focus: number }>>(ext, 'activity');
    expect(Object.values(activity)[0].focus).toBe(1);
  });

  it('the toolbar button opens our new tab', async () => {
    const opened = ext.ctx.waitForEvent('page');
    await ext.sw.evaluate(() => (chrome.action.onClicked as unknown as { dispatch(t: object): void }).dispatch({ id: 1 }));
    const tab = await opened;
    await tab.waitForLoadState();
    expect(tab.url()).toContain('src/pages/newtab/index.html');
    await tab.close();
  });

  it('syncs the alphaXiv library through its MCP server, refreshing an expired token once', async () => {
    const calls: string[] = [];
    await ext.ctx.route('https://api.alphaxiv.org/auth/oauth2/token', async (route) => {
      calls.push(`token:${new URLSearchParams(route.request().postData() ?? '').get('refresh_token')}`);
      await route.fulfill({ json: { access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 } });
    });
    await ext.ctx.route('https://api.alphaxiv.org/mcp/v1', async (route) => {
      const req = route.request();
      const body = req.postDataJSON() as { id?: number; method: string; params?: { name: string } };
      if (req.headers().authorization !== 'Bearer fresh') {
        calls.push('401');
        return route.fulfill({ status: 401, body: '' });
      }
      calls.push(body.params?.name ?? body.method);
      if (body.method === 'initialize')
        return route.fulfill({ headers: { 'mcp-session-id': 's1' }, json: { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } } } });
      if (body.method === 'notifications/initialized') return route.fulfill({ status: 202, body: '' });
      expect(req.headers()['mcp-session-id']).toBe('s1');
      // The real server streams: SSE with a notification first.
      const reply = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: LIST_LIBRARY }] } };
      return route.fulfill({
        headers: { 'content-type': 'text/event-stream' },
        body: `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ${JSON.stringify(reply)}\n\n`,
      });
    });
    await seed(ext, {
      alphaxivAuth: { clientId: 'c', redirectUri: 'r', accessToken: 'expired', refreshToken: 'r1', expiresAt: Date.now() + 3_600_000 },
      alphaxivStatus: { email: 'me@example.edu', lastSyncAt: null, error: '' },
      papers: [],
      alphaxivPush: [],
    });
    expect(await send({ type: 'ALPHAXIV_SYNC', force: true })).toEqual({ ok: true });
    // The stale token is refused at initialize; one refresh (with the stored refresh token), then the session.
    expect(calls).toEqual(['401', 'token:r1', 'initialize', 'notifications/initialized', 'list_library']);
    expect((await storage<{ name: string }[]>(ext, 'folders')).map((f) => f.name)).toEqual(['Want to read', 'Reading', 'Completed', 'My publications']);
    expect((await storage<unknown[]>(ext, 'papers')).length).toBe(5);
    expect(await storage(ext, 'alphaxivAuth')).toMatchObject({ accessToken: 'fresh', refreshToken: 'r2' });
    expect(await storage(ext, 'alphaxivStatus')).toMatchObject({ error: '' });
  });
});

describe('rust port: phase 3 brain dump and vault', () => {
  let ext: Ext;
  const DUMPS = 'src/pages/dumps/index.html';

  beforeAll(async () => {
    ext = await launch();
  });
  afterAll(async () => ext?.close());

  it('first dump: Haiku streams bullets, setup makes a vault, and the dump locks', async () => {
    await mockClaude(ext, (system) => (system.includes('looping') ? '- Work feels heavy today.\n- That is a feeling, not a verdict.' : ''));
    await seed(ext, { settings: { claudeKey: 'sk-e2e' }, vault: null, lockedDumps: [], dumps: [] });
    const page = await ext.page(PAGES.newtab);
    const box = page.getByLabel('Empty your head here');
    await box.fill('work is too much and I am behind');
    await box.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    const bullets = page.locator('.notebook-bullets li');
    await expect.poll(() => bullets.allInnerTexts()).toEqual(['Work feels heavy today.', 'That is a feeling, not a verdict.']);
    // Parked in the clear until setup finishes. Bullets show while Haiku streams, before the save: wait for it.
    await expect.poll(async () => (await storage<{ text: string }[]>(ext, 'dumps'))[0]?.text).toBe('work is too much and I am behind');

    await page.getByLabel('Passphrase', { exact: true }).fill('correct horse');
    await page.getByLabel('Passphrase again').fill('correct horse');
    await page.getByRole('button', { name: 'Lock it' }).click();
    await expect.poll(() => page.locator('.notebook-code').innerText(), { timeout: 20_000 }).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{1,4}){6}$/);
    await page.getByRole('button', { name: 'I wrote it down' }).click();
    await expect.poll(() => page.locator('.notebook-count').innerText(), { timeout: 20_000 }).toContain('1 locked');
    expect(await storage(ext, 'dumps')).toEqual([]);
    expect(JSON.stringify(await storage(ext, 'lockedDumps'))).not.toContain('behind');
    await expectA11y(page, 'newtab');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('without a key the words are kept and the box says how to get bullets', async () => {
    await seed(ext, { settings: { claudeKey: '' }, vault: null, lockedDumps: [], dumps: [] });
    const page = await ext.page(PAGES.newtab);
    await page.getByLabel('Empty your head here').fill('just this');
    await page.getByLabel('Empty your head here').press('Meta+Enter');
    await expect.poll(() => page.getByRole('alert').innerText()).toContain('Add a Claude key in Settings');
    expect((await storage<{ text: string }[]>(ext, 'dumps'))[0].text).toBe('just this');
    await page.close();
  });

  it('opens a vault the TypeScript build made, and seals into it', async () => {
    // Made and sealed by the TypeScript implementation before it was deleted
    // (e2e/fixtures/ts-vault.json): profiles carry such vaults, so they must keep opening.
    const { vault, lockedDumps, recoveryCode } = TS_VAULT;
    await seed(ext, { vault, lockedDumps, dumps: [] });

    // ...Rust opens it with the passphrase...
    const page = await ext.page(DUMPS);
    await page.getByLabel('Passphrase').fill('wrong');
    await page.getByLabel('Passphrase').press('Enter');
    await expect.poll(() => page.getByRole('alert').innerText(), { timeout: 20_000 }).toBe("That didn't unlock it.");
    await page.getByLabel('Passphrase').fill('correct horse');
    await page.getByLabel('Passphrase').press('Enter');
    await expect.poll(() => page.locator('.dumps-bullets li').allInnerTexts(), { timeout: 20_000 }).toEqual(['A bullet from TS.']);
    await page.getByRole('button', { name: 'Show what I wrote' }).click();
    expect(await page.locator('.dumps-raw').innerText()).toBe('made by TypeScript');
    await expectA11y(page, 'dumps');
    await page.close();

    // ...and with the recovery code, typed sloppily.
    const again = await ext.page(DUMPS);
    await again.getByRole('button', { name: 'Use recovery code instead' }).click();
    await again.getByLabel('Recovery code').fill(recoveryCode.toLowerCase().replace(/-/g, ' '));
    await again.getByLabel('Recovery code').press('Enter');
    await expect.poll(() => again.locator('.dumps-bullets li').count(), { timeout: 20_000 }).toBe(1);
    await again.close();

    // Rust seals a new dump into that vault; the next test opens both.
    await mockClaude(ext, () => '- Rust sealed this.');
    await seed(ext, { settings: { claudeKey: 'sk-e2e' } });
    const tab = await ext.page(PAGES.newtab);
    await tab.getByLabel('Empty your head here').fill('written in the Rust build');
    await tab.getByLabel('Empty your head here').press('Meta+Enter');
    await expect.poll(() => tab.locator('.notebook-count').innerText(), { timeout: 20_000 }).toContain('2 locked');
    expect(JSON.stringify(await storage(ext, 'lockedDumps'))).not.toContain('written in the Rust build');
    await tab.close();
  });

  it('deleting an entry asks first and removes only that one', async () => {
    const page = await ext.page(DUMPS);
    await page.getByLabel('Passphrase').fill('correct horse');
    await page.getByLabel('Passphrase').press('Enter');
    await expect.poll(() => page.locator('.dumps-entry').count(), { timeout: 20_000 }).toBe(2);
    // Both open with the one passphrase: TypeScript's sealed entry and the Rust one.
    expect(await page.locator('.dumps-bullets li').allInnerTexts()).toEqual(expect.arrayContaining(['A bullet from TS.', 'Rust sealed this.']));
    await page.locator('.dumps-entry').first().getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Keep' }).click();
    expect(await page.locator('.dumps-entry').count()).toBe(2);
    await page.locator('.dumps-entry').first().getByRole('button', { name: 'Delete' }).click();
    await page.locator('.dumps-confirm').getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => page.locator('.dumps-entry').count()).toBe(1);
    expect((await storage<unknown[]>(ext, 'lockedDumps')).length).toBe(1);
    await page.close();
  });

  it('one Haiku call gives the bullets and puts at most three top tasks on the board', async () => {
    const calls = await mockClaude(ext, () =>
      'Lighter:\n- Rent is on your mind.\n\nTop tasks:\n- 2099-01-02 09:00 | Pay the rent\n- | Call the dentist\n- | Email Sam\n- | A fourth one',
    );
    await seed(ext, { settings: { claudeKey: 'sk-e2e' }, vault: null, lockedDumps: [], dumps: [], todos: [] });
    const page = await ext.page(PAGES.newtab);
    const box = page.getByLabel('Empty your head here');
    await box.fill('rent is due, dentist, sam wants the email, ugh');
    await box.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await expect.poll(() => page.locator('.notebook-bullets li').allInnerTexts()).toEqual(['Rent is on your mind.']);
    await expect.poll(async () => (await storage<{ text: string }[]>(ext, 'todos')).map((t) => t.text)).toEqual(['Pay the rent', 'Call the dentist', 'Email Sam']);
    expect((await storage<{ dueAt: number | null }[]>(ext, 'todos'))[0].dueAt).toBe(new Date(2099, 0, 2, 9, 0).getTime());
    expect(calls).toHaveLength(1);
    expect(await page.getByRole('button', { name: 'Make to-dos' }).count()).toBe(0);
    await page.close();
  });

});
