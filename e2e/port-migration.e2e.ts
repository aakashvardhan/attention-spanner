import { describe, expect, it } from 'vitest';
import { launch, seed, storage } from './harness';

/**
 * An old (v26) profile migrated by the Rust worker. It seeds the old shapes on
 * purpose, so cutFeatures.test.ts skips this file.
 */
describe('rust port: phase 2 migration on update', () => {
  it('migrates a v26 profile when the extension updates', async () => {
    const ext = await launch();
    await seed(ext, {
      schemaVersion: 26,
      settings: { claudeKey: 'sk', theme: 'paperwhite', ollamaUrl: 'u', focusBlocklist: ['x.com'] },
      papers: [
        { id: 'p1', deckId: 'd1', title: 'P', url: 'https://arxiv.org/abs/2006.11239', status: 'reading', progressPercent: 20 },
        { id: 'p2', deckId: 'd1', title: 'W', url: 'https://example.com/w.pdf', status: 'to-read', progressPercent: 0 },
      ],
      decks: [{ id: 'd1', name: 'Diffusion' }],
      feeds: ['https://lwn.net/feed'],
      focusSession: { startedAt: 1, phase: 'focus', phaseEndsAt: 2, round: 1 },
    });
    // A real v26 profile has no push queue; this one was installed fresh before being seeded.
    await ext.sw.evaluate(() => chrome.storage.local.remove('alphaxivPush'));
    // What an update does: fire the worker's own onInstalled listener (Playwright cannot follow a reloaded worker).
    await ext.sw.evaluate(() => (chrome.runtime.onInstalled as unknown as { dispatch(d: object): void }).dispatch({ reason: 'update' }));
    await expect.poll(() => storage(ext, 'schemaVersion'), { timeout: 10_000 }).toBe(29);
    expect(await storage(ext, 'settings')).toEqual({ claudeKey: 'sk', focusBlocklist: ['x.com'] });
    expect((await storage<{ id: string }[]>(ext, 'papers')).map((p) => p.id)).toEqual(['2006.11239']);
    expect(await storage(ext, 'alphaxivPush')).toEqual([{ id: '2006.11239', folder: 'Diffusion' }]);
    expect(await storage(ext, 'feeds')).toBeUndefined();
    expect(await storage(ext, 'decks')).toBeUndefined();
    expect(await storage(ext, 'focusSession')).toBeNull();
    await ext.close();
  });
});
