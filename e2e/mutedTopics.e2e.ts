import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NETWORK_NOISE, PAGES, expectA11y, expectClean, launch, seed, storage, type Ext } from './harness';

describe('muted topics in Settings', () => {
  let ext: Ext;
  beforeAll(async () => {
    ext = await launch();
    await seed(ext, { settings: { ollamaUrl: 'http://127.0.0.1:9' } });
  });
  afterAll(async () => ext.close());
  beforeEach(() => void ext.errors.splice(0));

  it('saves a cleaned list on blur and Escape restores the saved one', async () => {
    const page = await ext.page(PAGES.options);
    const field = page.getByLabel('Hide from your feeds');
    await field.fill('  Sports \n\nsports\nUS   election');
    await field.blur();
    await expect
      .poll(async () => (await storage<{ mutedTopics?: string[] }>(ext, 'settings'))?.mutedTopics)
      .toEqual(['Sports', 'US election']);
    expect(await field.inputValue()).toBe('Sports\nUS election');

    await field.fill('something unsaved');
    await field.press('Escape');
    expect(await field.inputValue()).toBe('Sports\nUS election');
    await expectA11y(page, 'options');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
});
