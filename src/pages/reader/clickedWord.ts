/** Letters and digits, with hyphens and apostrophes inside a word ("temporal-difference"). */
const WORD_CHAR = /[\p{L}\p{N}\-'’]/u;
/** Characters of the page on each side of the word that the model reads. */
const CONTEXT_CHARS = 300;
/** Characters on each side that key the cache: the same word in another phrase may be another term. */
const NEAR_CHARS = 30;

/**
 * The word holding the character at `offset` in a page's text, plus the text around it
 * so the model can tell which term the word belongs to. Null for a click on a
 * space, punctuation, or a lone character.
 */
export function clickedWord(
  text: string,
  offset: number,
): { word: string; context: string; near: string } | null {
  if (!WORD_CHAR.test(text[offset] ?? '')) return null;
  let start = offset;
  let end = offset;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
  while (end < text.length && WORD_CHAR.test(text[end])) end++;
  const raw = text.slice(start, end);
  const word = raw.replace(/^[-'’]+/, '').replace(/(?:['’]s)?[-'’]*$/u, '');
  if (word.length < 2 || !/\p{L}/u.test(word)) return null;
  start += raw.indexOf(word);
  end = start + word.length;
  return {
    word,
    context: text.slice(Math.max(0, start - CONTEXT_CHARS), end + CONTEXT_CHARS).trim(),
    near: text.slice(Math.max(0, start - NEAR_CHARS), end + NEAR_CHARS).trim(),
  };
}
