import { describe, expect, it } from 'vitest';
import { groundPdfOutline, pdfOutlineCacheKey } from './pdfOutline';

const pages = [
  'Abstract We study reader attention in long documents. The measured completion rate improved by twelve percent.',
  '2 Methods Participants read the same papers in a controlled crossover study. Every interaction was recorded locally.',
];

describe('groundPdfOutline', () => {
  it('keeps only headings and passages that occur on the claimed page', () => {
    expect(
      groundPdfOutline(
        [
          {
            title: 'Abstract',
            summary: 'A model-authored claim is never displayed.',
            evidence: 'We study reader attention in long documents.',
            page: 1,
            level: 0,
          },
          {
            title: 'Conclusion',
            summary: 'Invented.',
            evidence: 'The imaginary treatment cured every participant.',
            page: 2,
            level: 0,
          },
        ],
        pages,
      ),
    ).toEqual([
      {
        title: 'Abstract',
        summary: 'We study reader attention in long documents.',
        page: 1,
        level: 0,
      },
    ]);
  });

  it('displays punctuation copied from the PDF rather than model punctuation', () => {
    expect(
      groundPdfOutline(
        [{
          title: 'abstract',
          summary: 'Ignored.',
          evidence: 'we study reader attention in long documents!',
          page: 1,
          level: 0,
        }],
        pages,
      )[0],
    ).toMatchObject({
      title: 'Abstract',
      summary: 'We study reader attention in long documents.',
    });
  });

  it('uses the PDF bookmark title, page, and hierarchy as authoritative', () => {
    const bookmarks = [{ title: '2 Methods', page: 2, level: 1 }];
    expect(
      groundPdfOutline(
        [
          {
            title: '2 methods',
            summary: 'Ignored generated summary.',
            evidence: 'Participants read the same papers in a controlled crossover study.',
            page: 2,
            level: 1,
          },
          {
            title: '2 Methods',
            summary: 'Wrong depth.',
            evidence: 'Participants read the same papers in a controlled crossover study.',
            page: 2,
            level: 0,
          },
        ],
        pages,
        bookmarks,
      ),
    ).toEqual([
      {
        title: '2 Methods',
        summary: 'Participants read the same papers in a controlled crossover study.',
        page: 2,
        level: 1,
      },
    ]);
  });

  it('builds a stable content-addressed cache key', () => {
    expect(pdfOutlineCacheKey(pages)).toBe(pdfOutlineCacheKey([...pages]));
    expect(pdfOutlineCacheKey(pages)).not.toBe(pdfOutlineCacheKey([pages[0], `${pages[1]} changed`]));
  });
});
