import { describe, expect, it } from 'vitest';
import { ttsCleanText } from './tts';

describe('ttsCleanText', () => {
  it('strips markdown syntax and links', () => {
    expect(ttsCleanText('**Bold** and `code` and [a link](https://x.test)')).toBe(
      'Bold and code and a link',
    );
  });

  it('replaces code blocks and collapses whitespace', () => {
    expect(ttsCleanText('before\n```js\nconst x = 1;\n```\nafter')).toBe(
      'before code block after',
    );
  });

  it('returns empty for empty-ish input', () => {
    expect(ttsCleanText('   ')).toBe('');
  });
});
