import { describe, expect, it } from 'vitest';
import { trustedWatchMeta } from './watchMeta';

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
});
