import { describe, expect, it } from 'vitest';
import { findTextAnchor, makeTextAnchor, TEXT_ANCHOR_CONTEXT_CHARS } from './textAnchor';

const BLOCKS = [
  'Attention is a limited resource that the modern web actively mines.',
  'The same phrase appears twice here. The same phrase appears twice here too.',
  'Closing thoughts about attention and how little of it survives a feed.',
];

describe('makeTextAnchor', () => {
  it('captures the quote with surrounding context', () => {
    const anchor = makeTextAnchor(BLOCKS, 0, 0, 9);
    expect(anchor).toEqual({
      blockIndex: 0,
      quote: 'Attention',
      prefix: '',
      suffix: ' is a limited resource that the '.slice(0, TEXT_ANCHOR_CONTEXT_CHARS),
    });
  });

  it('rejects a whitespace-only selection', () => {
    expect(makeTextAnchor(['some text here'], 0, 4, 5)).toBeNull();
  });

  it('rejects a block index that does not exist', () => {
    expect(makeTextAnchor(BLOCKS, 9, 0, 3)).toBeNull();
  });
});

describe('findTextAnchor', () => {
  it('re-finds an unchanged quote', () => {
    const anchor = makeTextAnchor(BLOCKS, 0, 0, 9)!;
    expect(findTextAnchor(BLOCKS, anchor)).toEqual({ blockIndex: 0, start: 0, end: 9 });
  });

  it('picks the right one of two identical quotes using context', () => {
    const second = BLOCKS[1].lastIndexOf('The same phrase');
    const anchor = makeTextAnchor(BLOCKS, 1, second, second + 15)!;
    expect(findTextAnchor(BLOCKS, anchor)).toEqual({
      blockIndex: 1,
      start: second,
      end: second + 15,
    });
  });

  it('follows the quote when blocks shift', () => {
    const anchor = makeTextAnchor(BLOCKS, 0, 0, 9)!;
    const shifted = ['A newly inserted intro paragraph.', ...BLOCKS];
    expect(findTextAnchor(shifted, anchor)).toEqual({ blockIndex: 1, start: 0, end: 9 });
  });

  it('returns null when the quote is gone', () => {
    const anchor = makeTextAnchor(BLOCKS, 0, 0, 9)!;
    expect(findTextAnchor(['Entirely different content now.'], anchor)).toBeNull();
  });

  it('still resolves when the surrounding context changed', () => {
    const at = BLOCKS[2].indexOf('attention');
    const anchor = makeTextAnchor(BLOCKS, 2, at, at + 'attention'.length)!;
    const edited = ['Closing thoughts, revised, about attention in general.'];
    const hit = findTextAnchor(edited, anchor);
    expect(hit).not.toBeNull();
    expect(edited[0].slice(hit!.start, hit!.end)).toBe('attention');
  });
});
