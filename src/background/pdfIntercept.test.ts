import { describe, expect, it } from 'vitest';
import { ARXIV_PDF_FILTER } from './pdfIntercept';

const re = new RegExp(ARXIV_PDF_FILTER);

describe('ARXIV_PDF_FILTER', () => {
  it('sends arXiv PDF links to the reader, versioned and legacy ids too', () => {
    for (const url of [
      'https://arxiv.org/pdf/1706.03762',
      'https://arxiv.org/pdf/1706.03762v7',
      'https://www.arxiv.org/pdf/2406.09246.pdf',
      'http://export.arxiv.org/pdf/hep-th/9901001',
    ])
      expect(re.test(url), url).toBe(true);
  });

  it('leaves abs pages, other hosts, look-alikes and local files alone', () => {
    for (const url of [
      'https://arxiv.org/abs/1706.03762',
      'https://arxiv.org/pdf/',
      'https://example.com/paper.pdf',
      'https://notarxiv.org/pdf/1706.03762',
      'https://arxiv.org.evil.com/pdf/1706.03762',
      'file:///Users/me/paper.pdf',
    ])
      expect(re.test(url), url).toBe(false);
  });
});
