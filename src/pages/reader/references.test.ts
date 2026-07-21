import { describe, expect, it } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { extractRefLink, getPdfText, parseBibliography, resolveCitation } from './references';

/** Minimal pdf.js-shaped stub that counts how many pages were actually read. */
function stubDoc(pages: string[]): { doc: PDFDocumentProxy; reads: () => number } {
  let reads = 0;
  const doc = {
    numPages: pages.length,
    getPage: async (i: number) => {
      reads++;
      return { getTextContent: async () => ({ items: [{ str: pages[i - 1], hasEOL: true }] }) };
    },
  };
  return { doc: doc as unknown as PDFDocumentProxy, reads: () => reads };
}

describe('getPdfText caching', () => {
  it('extracts a document once and reuses the cached text', async () => {
    const { doc, reads } = stubDoc(['Intro. ', 'Method.']);
    const first = await getPdfText(doc);
    const second = await getPdfText(doc);
    expect(first).toBe(second);
    expect(first).toContain('Intro');
    expect(first).toContain('Method');
    expect(reads()).toBe(2); // two pages, read once total — not four
  });

  it('dedupes concurrent callers into a single extraction', async () => {
    const { doc, reads } = stubDoc(['a', 'b']);
    const [a, b] = await Promise.all([getPdfText(doc), getPdfText(doc)]);
    expect(a).toBe(b);
    expect(reads()).toBe(2);
  });

  it('does not cache a failed extraction, so it can be retried', async () => {
    let attempt = 0;
    const doc = {
      numPages: 1,
      getPage: async () => {
        attempt++;
        if (attempt === 1) throw new Error('boom');
        return { getTextContent: async () => ({ items: [{ str: 'recovered', hasEOL: false }] }) };
      },
    } as unknown as PDFDocumentProxy;
    await expect(getPdfText(doc)).rejects.toThrow('boom');
    await expect(getPdfText(doc)).resolves.toContain('recovered');
  });
});

describe('extractRefLink', () => {
  it('prefers a canonical arXiv link', () => {
    expect(extractRefLink('Vaswani et al. Attention is all you need. arXiv:1706.03762, 2017.')).toBe(
      'https://arxiv.org/abs/1706.03762',
    );
    expect(extractRefLink('… https://arxiv.org/abs/2006.11239v3 …')).toBe(
      'https://arxiv.org/abs/2006.11239',
    );
  });

  it('falls back to DOI then bare URL', () => {
    expect(extractRefLink('Some paper. doi:10.1145/3292500.3330701.')).toBe(
      'https://doi.org/10.1145/3292500.3330701',
    );
    expect(extractRefLink('See https://example.com/paper.html for details.')).toBe(
      'https://example.com/paper.html',
    );
  });

  it('returns null when there is nothing linkable', () => {
    expect(extractRefLink('J. Smith. A book with no link. Publisher, 2001.')).toBeNull();
  });
});

describe('parseBibliography — numbered [n]', () => {
  const text = [
    'Body of the paper mentions references [1] and [2] here.',
    'More body text about the method.',
    'References',
    '[1] A. Vaswani et al. Attention is all you need. arXiv:1706.03762, 2017.',
    '[2] J. Devlin et al. BERT: Pre-training of deep bidirectional transformers. 2019.',
  ].join('\n');

  it('splits entries and resolves labels with links', () => {
    const index = parseBibliography(text);
    expect(index.isEmpty).toBe(false);
    const [ref] = resolveCitation(index, { labels: ['1'] });
    expect(ref.text).toContain('Attention is all you need');
    expect(ref.link).toBe('https://arxiv.org/abs/1706.03762');
    expect(resolveCitation(index, { labels: ['1', '2'] })).toHaveLength(2);
  });
});

describe('parseBibliography — author-year', () => {
  const text = [
    'Introduction citing (Vaswani et al., 2017) and Devlin et al. (2019).',
    'Bibliography',
    'Vaswani, A., Shazeer, N. Attention is all you need. NeurIPS, 2017.',
    'Devlin, J., Chang, M. BERT. NAACL, 2019.',
  ].join('\n');

  it('indexes by first-author surname and year', () => {
    const index = parseBibliography(text);
    const [ref] = resolveCitation(index, { author: 'Vaswani', year: 2017 });
    expect(ref.text).toContain('Attention is all you need');
    expect(resolveCitation(index, { author: 'Devlin', year: 2019 })).toHaveLength(1);
    expect(resolveCitation(index, { author: 'Nobody', year: 2000 })).toHaveLength(0);
  });
});

describe('parseBibliography — no references section', () => {
  it('returns an empty index', () => {
    expect(parseBibliography('Just some prose with no bibliography at all.').isEmpty).toBe(true);
  });
});
