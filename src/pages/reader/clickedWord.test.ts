import { describe, expect, it } from 'vitest';
import { clickedWord } from './clickedWord';

describe('clickedWord', () => {
  const text = 'We use temporal-difference (TD) learning, as in Samuel’s checkers player.';

  it('takes the whole word under the click, hyphens included', () => {
    expect(clickedWord(text, text.indexOf('difference') + 3)?.word).toBe('temporal-difference');
    expect(clickedWord(text, text.indexOf('TD') + 1)?.word).toBe('TD');
    expect(clickedWord(text, text.indexOf('learning') + 7)?.word).toBe('learning');
  });

  it('drops a trailing apostrophe-s and punctuation', () => {
    expect(clickedWord(text, text.indexOf('Samuel') + 1)?.word).toBe('Samuel');
  });

  it('ignores clicks on spaces, punctuation and lone characters', () => {
    expect(clickedWord(text, text.indexOf(' use'))).toBeNull();
    expect(clickedWord(text, text.indexOf('('))).toBeNull();
    expect(clickedWord('a b', 0)).toBeNull();
  });

  it('gives the model the text around the word, and a short span to key the cache on', () => {
    const long = `${'x '.repeat(400)}the eligibility trace decays${' y'.repeat(400)}`;
    const hit = clickedWord(long, long.indexOf('eligibility'))!;
    expect(hit.context).toContain('the eligibility trace decays');
    expect(hit.context.length).toBeLessThan(700);
    expect(hit.near).toContain('eligibility');
    expect(hit.near.length).toBeLessThan(long.length);
  });
});
