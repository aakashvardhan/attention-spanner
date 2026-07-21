import { describe, expect, it } from 'vitest';
import { flattenOutline, headingForPage, type RawOutlineItem } from './pdfOutline';

const pages = new Map<unknown, number>([
  ['intro', 1],
  ['method', 3],
  ['method-a', 3],
  ['results', 7],
]);
const lookup = (dest: unknown): number | null => pages.get(dest) ?? null;

const outline: RawOutlineItem[] = [
  { title: '1 Introduction', dest: 'intro' },
  {
    title: '2 Method',
    dest: 'method',
    items: [{ title: '2.1 Setup ', dest: 'method-a' }],
  },
  { title: '3 Results', dest: 'results' },
];

describe('flattenOutline', () => {
  it('flattens depth-first with levels, trimming titles', () => {
    expect(flattenOutline(outline, lookup)).toEqual([
      { title: '1 Introduction', level: 0, page: 1 },
      { title: '2 Method', level: 0, page: 3 },
      { title: '2.1 Setup', level: 1, page: 3 },
      { title: '3 Results', level: 0, page: 7 },
    ]);
  });

  it('drops unresolvable dests but keeps their children', () => {
    const broken: RawOutlineItem[] = [
      { title: 'Ghost', dest: 'missing', items: [{ title: 'Child', dest: 'results' }] },
    ];
    expect(flattenOutline(broken, lookup)).toEqual([{ title: 'Child', level: 1, page: 7 }]);
  });
});

describe('headingForPage', () => {
  const flat = flattenOutline(outline, lookup);

  it('returns the exact or nearest-before heading', () => {
    expect(headingForPage(flat, 1)).toBe('1 Introduction');
    expect(headingForPage(flat, 2)).toBe('1 Introduction');
    expect(headingForPage(flat, 7)).toBe('3 Results');
    expect(headingForPage(flat, 20)).toBe('3 Results');
  });

  it('picks the last of several headings on one page', () => {
    expect(headingForPage(flat, 3)).toBe('2.1 Setup');
    expect(headingForPage(flat, 5)).toBe('2.1 Setup');
  });

  it('returns null before the first heading or with no outline', () => {
    const late = flattenOutline([{ title: 'Appendix', dest: 'results' }], lookup);
    expect(headingForPage(late, 2)).toBeNull();
    expect(headingForPage([], 1)).toBeNull();
  });
});
