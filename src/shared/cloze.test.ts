import { describe, expect, it } from 'vitest';
import { clozeIndexes, clozeText, renderCloze } from './cloze';

describe('clozeIndexes', () => {
  it('finds a single cloze', () => {
    expect(clozeIndexes('The {{c1::mitochondria}} is the powerhouse')).toEqual([1]);
  });

  it('dedupes repeated indexes into one card', () => {
    expect(clozeIndexes('{{c1::A}} and {{c1::B}}')).toEqual([1]);
  });

  it('returns sorted distinct indexes, tolerating gaps', () => {
    expect(clozeIndexes('{{c3::C}} {{c1::A}}')).toEqual([1, 3]);
  });

  it('returns [] for text without clozes', () => {
    expect(clozeIndexes('plain text')).toEqual([]);
    expect(clozeIndexes('almost {{c::x}} and {c1::y}')).toEqual([]);
  });

  it('ignores malformed c0 and non-numeric indexes', () => {
    expect(clozeIndexes('{{c0::zero}} {{cx::letters}}')).toEqual([]);
  });

  it('handles multiline answers', () => {
    expect(clozeIndexes('{{c1::line one\nline two}}')).toEqual([1]);
  });
});

describe('renderCloze', () => {
  const text = 'The {{c1::mitochondria}} makes {{c2::ATP}}';

  it('blanks only the active index on the front', () => {
    expect(clozeText(text, 1, 'front')).toBe('The [...] makes ATP');
    expect(clozeText(text, 2, 'front')).toBe('The mitochondria makes [...]');
  });

  it('reveals the answer on the back', () => {
    expect(clozeText(text, 1, 'back')).toBe('The mitochondria makes ATP');
  });

  it('marks active segments so the UI can accent them', () => {
    const segs = renderCloze(text, 1, 'back');
    const active = segs.filter((s) => s.cloze?.active);
    expect(active).toHaveLength(1);
    expect(active[0].text).toBe('mitochondria');
    const inactive = segs.filter((s) => s.cloze && !s.cloze.active);
    expect(inactive[0].text).toBe('ATP');
  });

  it('shows the hint instead of ... when present', () => {
    expect(clozeText('{{c1::Paris::city}} is the capital', 1, 'front')).toBe(
      '[city] is the capital',
    );
  });

  it('blanks every occurrence of a repeated index', () => {
    expect(clozeText('{{c1::A}} then {{c1::B}}', 1, 'front')).toBe('[...] then [...]');
    expect(clozeText('{{c1::A}} then {{c1::B}}', 1, 'back')).toBe('A then B');
  });

  it('keeps :: inside answers when a hint follows', () => {
    // {{c1::std::vector::container}} → answer "std", hint "vector::container"
    expect(clozeText('{{c1::std::vector::container}}', 1, 'front')).toBe('[vector::container]');
    expect(clozeText('{{c1::std::vector::container}}', 1, 'back')).toBe('std');
  });

  it('leaves malformed c0 markers as raw text', () => {
    expect(clozeText('{{c0::zero}} ok', 1, 'front')).toBe('{{c0::zero}} ok');
  });

  it('handles multiline answers', () => {
    expect(clozeText('{{c1::one\ntwo}} end', 1, 'back')).toBe('one\ntwo end');
  });
});
