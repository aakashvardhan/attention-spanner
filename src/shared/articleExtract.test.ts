import { describe, expect, it } from 'vitest';
import {
  articleText,
  clean,
  keepBlock,
  kindOf,
  outlineOf,
  titleFrom,
  type ArticleBlock,
} from './articleExtract';

/*
 * The DOM walk itself runs in the browser end-to-end pass (it needs a real
 * Document, and adding a DOM implementation as a dependency to test a
 * ten-line loop is not a trade worth making). Everything the walk decides
 * lives in these pure helpers and is covered here.
 */

const heading = (text: string, level: number): ArticleBlock => ({ kind: 'heading', text, level });
const para = (text: string): ArticleBlock => ({ kind: 'para', text, level: 0 });

describe('clean', () => {
  it('collapses whitespace and trims', () => {
    expect(clean('  a \n\t b   c ')).toBe('a b c');
    expect(clean('\n\n')).toBe('');
  });
});

describe('kindOf', () => {
  it('maps tags to block kinds', () => {
    expect(kindOf('h1')).toBe('heading');
    expect(kindOf('h6')).toBe('heading');
    expect(kindOf('blockquote')).toBe('quote');
    expect(kindOf('pre')).toBe('code');
    expect(kindOf('li')).toBe('list');
    expect(kindOf('p')).toBe('para');
    expect(kindOf('div')).toBe('para');
  });
});

describe('keepBlock', () => {
  it('drops empty blocks of any kind', () => {
    expect(keepBlock('para', '')).toBe(false);
    expect(keepBlock('heading', '')).toBe(false);
  });

  it('drops short bare paragraphs, which are labels not prose', () => {
    expect(keepBlock('para', 'Share this')).toBe(false);
    expect(keepBlock('para', 'A paragraph long enough to be real prose.')).toBe(true);
  });

  it('keeps short headings, quotes, code and list items', () => {
    expect(keepBlock('heading', 'Intro')).toBe(true);
    expect(keepBlock('quote', 'Short.')).toBe(true);
    expect(keepBlock('code', 'npm i')).toBe(true);
    expect(keepBlock('list', 'One')).toBe(true);
  });
});

describe('titleFrom', () => {
  it('prefers the document title', () => {
    expect(titleFrom('  Doc Title ', [heading('H1 Title', 1)], 'fallback')).toBe('Doc Title');
  });

  it('falls back to the h1, then to the caller fallback', () => {
    expect(titleFrom('', [heading('H1 Title', 1)], 'fallback')).toBe('H1 Title');
    expect(titleFrom('', [heading('Sub', 2)], 'fallback')).toBe('fallback');
    expect(titleFrom('', [], 'fallback')).toBe('fallback');
  });
});

describe('outlineOf', () => {
  it('keeps headings with their block index, in order', () => {
    const blocks = [heading('One', 1), para('body text that is long enough'), heading('Two', 2)];
    expect(outlineOf(blocks)).toEqual([
      { title: 'One', level: 1, blockIndex: 0 },
      { title: 'Two', level: 2, blockIndex: 2 },
    ]);
  });

  it('is empty for an article with no headings', () => {
    expect(outlineOf([para('just a paragraph of body text here')])).toEqual([]);
  });
});

describe('articleText', () => {
  it('joins blocks with blank lines for the AI panels', () => {
    expect(articleText([heading('T', 1), para('Body copy goes here, at length.')])).toBe(
      'T\n\nBody copy goes here, at length.',
    );
  });
});
