import { describe, expect, it } from 'vitest';
import { formatHit, searchLibrary, tokenize, type LibraryDoc } from './library';

const doc = (over: Partial<LibraryDoc> & { id: string; text: string }): LibraryDoc => ({
  kind: 'highlight',
  title: 'Untitled',
  url: '',
  at: 0,
  ...over,
});

const CORPUS: LibraryDoc[] = [
  doc({
    id: 'attention',
    title: 'Sustained Attention',
    text: 'Attention is a negotiation between novelty seeking and sustained effort.',
    at: 100,
  }),
  doc({
    id: 'interruption',
    title: 'Context Switching',
    text: 'After an interruption the mind must rebuild the entire context it dropped.',
    at: 200,
  }),
  doc({
    id: 'gym',
    kind: 'note',
    title: 'Monday dump',
    text: 'Buy protein powder and book a squat rack.',
    at: 300,
  }),
];

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, drops stopwords and short words', () => {
    expect(tokenize('The mind, at REST — is a 42 thing!')).toEqual(['mind', 'rest', 'thing']);
  });

  it('returns nothing for a query of pure stopwords', () => {
    expect(tokenize('what did I do about it')).toEqual([]);
  });
});

describe('searchLibrary', () => {
  it('finds the document that actually discusses the term', () => {
    const [top] = searchLibrary(CORPUS, 'interruption context');
    expect(top.id).toBe('interruption');
  });

  it('ranks a focused short document above a long one mentioning the term once', () => {
    const focused = doc({ id: 'short', text: 'Attention is finite.', at: 1 });
    const padded = doc({
      id: 'long',
      text: `Attention. ${'Filler prose about unrelated matters. '.repeat(40)}`,
      at: 2,
    });
    const [top] = searchLibrary([padded, focused], 'attention');
    expect(top.id).toBe('short');
  });

  it('scores a term repeated many times above one mentioned once, but sub-linearly', () => {
    const once = doc({ id: 'once', text: 'streaks matter' });
    const many = doc({ id: 'many', text: 'streaks streaks streaks streaks matter' });
    const hits = searchLibrary([once, many], 'streaks');
    expect(hits[0].id).toBe('many');
    expect(hits[0].score).toBeLessThan(hits[1].score * 4);
  });

  it('returns nothing for a query with no usable terms or an empty corpus', () => {
    expect(searchLibrary(CORPUS, 'the and of')).toEqual([]);
    expect(searchLibrary([], 'attention')).toEqual([]);
  });

  it('omits documents that match nothing', () => {
    const hits = searchLibrary(CORPUS, 'attention');
    expect(hits.map((h) => h.id)).not.toContain('gym');
  });

  it('breaks score ties toward the more recent document', () => {
    const older = doc({ id: 'older', text: 'identical body text here', at: 1 });
    const newer = doc({ id: 'newer', text: 'identical body text here', at: 999 });
    expect(searchLibrary([older, newer], 'identical')[0].id).toBe('newer');
  });

  it('honours the result limit', () => {
    expect(searchLibrary(CORPUS, 'attention interruption protein', 1)).toHaveLength(1);
  });
});

describe('formatHit', () => {
  it('labels the kind and truncates long bodies', () => {
    const [hit] = searchLibrary(CORPUS, 'interruption');
    expect(formatHit(hit)).toBe(
      '- [highlight] Context Switching: After an interruption the mind must rebuild the entire context it dropped.',
    );
    expect(formatHit(hit, 10)).toContain('…');
  });
});
