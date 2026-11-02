import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIST_LIBRARY } from '../src/shared/alphaxiv.fixtures';
import { NETWORK_NOISE, PAGES, expectA11y, expectClean, launch, seed, storage, type Ext } from './harness';
import { paper } from './seed';

/**
 * The Rust port, phase by phase. Runs only against the Rust build
 * (DIST=rust/ext/dist/chromium npm run test:e2e); the rest of the suite is the
 * port's finish line and is pointed at it page by page as each lands.
 */
describe.skipIf(!process.env.DIST?.includes('rust'))('rust port: phase 0 skeleton', () => {
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
    await expect.poll(() => page.locator('main.edition .hint').innerText()).toBe('Reader, in Rust.');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
    expect(await page.title()).toBe('New Tab');
    // theme.css loaded: the walnut ground, not the browser's white
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(28, 20, 16)');
    await expectA11y(page, 'newtab');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
});

describe.skipIf(!process.env.DIST?.includes('rust'))('rust port: phase 2 worker', () => {
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
