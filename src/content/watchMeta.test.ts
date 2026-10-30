import { describe, expect, it } from 'vitest';
import { shouldKeepPolling, trustedWatchMeta } from './watchMeta';

/** Just enough of a Document: selectors map to elements with text and attributes. */
function fakeDoc(title: string, nodes: Record<string, { text?: string; attrs?: Record<string, string> }>) {
  return {
    title,
    querySelector: (selector: string) => {
      const node = nodes[selector];
      return node ? { textContent: node.text ?? '', getAttribute: (name: string) => node.attrs?.[name] ?? null } : null;
    },
  } as unknown as Document;
}

describe('trustedWatchMeta', () => {
  it('a matching video-id gives the watch page title and channel', () => {
    const doc = fakeDoc('(3) Old title - YouTube', {
      'ytd-watch-flexy': { attrs: { 'video-id': 'abc' } },
      'ytd-watch-metadata h1': { text: ' RL Course by David Silver ' },
      'ytd-watch-metadata ytd-channel-name a': { text: 'Google DeepMind' },
    });
    expect(trustedWatchMeta(doc, 'abc')).toEqual({ title: 'RL Course by David Silver', channel: 'Google DeepMind' });
  });

  it('a mismatched video-id is not trusted', () => {
    const doc = fakeDoc('Best pasta recipe - YouTube', {
      'ytd-watch-flexy': { attrs: { 'video-id': 'previous' } },
      'ytd-watch-metadata h1': { text: 'Best pasta recipe' },
    });
    expect(trustedWatchMeta(doc, 'abc')).toBeNull();
  });

  it('home page markup with a grid card channel is not trusted', () => {
    const doc = fakeDoc('YouTube', { 'ytd-channel-name a': { text: 'Some grid card channel' } });
    expect(trustedWatchMeta(doc, 'abc')).toBeNull();
  });

  it('a matching video-id with its title not rendered yet is not trusted', () => {
    const doc = fakeDoc('YouTube', {
      'ytd-watch-flexy': { attrs: { 'video-id': 'abc' } },
      'ytd-watch-metadata h1': { text: '  ' },
    });
    expect(trustedWatchMeta(doc, 'abc')).toBeNull();
  });
});

describe('shouldKeepPolling', () => {
  it('keeps polling on this video inside the wait', () => {
    expect(shouldKeepPolling('abc', 'abc', 1900)).toBe(true);
  });

  it('stops once the wait is over', () => {
    expect(shouldKeepPolling('abc', 'abc', 2000)).toBe(false);
  });

  it('stops as soon as the tab is on another video or page', () => {
    expect(shouldKeepPolling('xyz', 'abc', 0)).toBe(false);
    expect(shouldKeepPolling(null, 'abc', 0)).toBe(false);
  });
});
