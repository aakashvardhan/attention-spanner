import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActivePageContent } from './pageContent';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getActivePageContent', () => {
  it('reads the active tab in the panel current window', async () => {
    const query = vi.fn(async () => [
      { id: 17, url: 'https://deepmind.google/article', title: 'Gemini Robotics 2' },
    ]);
    const executeScript = vi.fn(async () => [
      {
        result: {
          title: 'Gemini Robotics 2',
          text: 'Gemini Robotics 2 can reason about physical tasks and act across different robots.'.repeat(
            3,
          ),
        },
      },
    ]);
    vi.stubGlobal('chrome', { tabs: { query }, scripting: { executeScript } });

    const page = await getActivePageContent(120);

    expect(query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 17 } }),
    );
    expect(page).toMatchObject({
      title: 'Gemini Robotics 2',
      url: 'https://deepmind.google/article',
    });
    expect(page?.text).toHaveLength(120);
  });

  it('declines browser-protected and extension URLs without injecting', async () => {
    const query = vi.fn(async () => [
      { id: 2, url: 'chrome://settings/', title: 'Settings' },
    ]);
    const executeScript = vi.fn();
    vi.stubGlobal('chrome', { tabs: { query }, scripting: { executeScript } });

    await expect(getActivePageContent()).resolves.toBeNull();
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('returns null rather than throwing when the active-tab query fails', async () => {
    const query = vi.fn(async () => {
      throw new Error('window closed');
    });
    vi.stubGlobal('chrome', { tabs: { query }, scripting: { executeScript: vi.fn() } });

    await expect(getActivePageContent()).resolves.toBeNull();
    // One initial query and one best-effort recovery query.
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('contains an injection failure when no HTML parser is available', async () => {
    const query = vi.fn(async () => [
      { id: 9, url: 'https://example.test/article', title: 'Article' },
    ]);
    const executeScript = vi.fn(async () => {
      throw new Error('tab navigated');
    });
    vi.stubGlobal('chrome', { tabs: { query }, scripting: { executeScript } });
    vi.stubGlobal('DOMParser', undefined);

    await expect(getActivePageContent()).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('rejects injected text that is too short to be an article', async () => {
    const query = vi.fn(async () => [
      { id: 11, url: 'https://example.test/article', title: 'Article' },
    ]);
    const executeScript = vi.fn(async () => [
      { result: { title: 'Article', text: 'Short navigation label' } },
    ]);
    vi.stubGlobal('chrome', { tabs: { query }, scripting: { executeScript } });
    vi.stubGlobal('DOMParser', undefined);

    await expect(getActivePageContent()).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
