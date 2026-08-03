import { describe, expect, it } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  allReferences,
  citationHref,
  extractRefLink,
  getPdfText,
  parseBibliography,
  resolveCitation,
  type Reference,
} from './references';
import { parsePaperRef } from '../../shared/papers';

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

  // A bibliography entry ends in a full stop, and the URL is usually the last
  // thing in it. Carrying that punctuation into the link produced
  // `arxiv.org/abs/2412.07755.` — which arXiv rejects outright ("Article
  // identifier not recognized"), so every citation of a paper written that way
  // led nowhere. The DOI and bare-URL branches already trimmed; this one did not.
  it('does not carry sentence punctuation into an arXiv link', () => {
    expect(extractRefLink('Smith et al. A paper. https://arxiv.org/abs/2412.07755. NeurIPS, 2024.')).toBe(
      'https://arxiv.org/abs/2412.07755',
    );
    expect(extractRefLink('… see https://arxiv.org/abs/2006.11239v3.')).toBe(
      'https://arxiv.org/abs/2006.11239',
    );
    expect(extractRefLink('(https://arxiv.org/pdf/1706.03762.pdf).')).toBe(
      'https://arxiv.org/abs/1706.03762',
    );
  });

  // The point of trimming: the link has to survive the round trip back into an
  // identifier, or the paper is neither recognised as one already tracked nor
  // expandable.
  it('produces a link the paper matcher recognises as arXiv', () => {
    const link = extractRefLink('A paper. https://arxiv.org/abs/2412.07755. 2024.')!;

    expect(parsePaperRef(link)).toBe('arXiv:2412.07755');
  });
});

describe('citationHref', () => {
  const entry = (text: string): Reference => ({
    label: '1', text, link: null, authorKey: null, year: null,
  });

  it('searches for an entry that carries no link of its own', () => {
    expect(citationHref(entry('J. Smith. A book. Publisher, 2001.'))).toContain(
      'semanticscholar.org/search',
    );
  });

  // A mis-split bibliography can leave one "entry" thousands of characters
  // long. Encoded into a query string that became a 3.8 KB URL, and the CDN in
  // front of Semantic Scholar answered 414 rather than searching — so the
  // fallback that exists to always work, didn't.
  it('keeps the search URL short enough to be served', () => {
    const huge = 'Author, A., and twenty more authors. '.repeat(80);

    expect(citationHref(entry(huge)).length).toBeLessThan(600);
  });

  it('still searches for something meaningful after trimming', () => {
    const huge = `Vaswani et al. Attention is all you need. ${'padding '.repeat(400)}`;

    expect(decodeURIComponent(citationHref(entry(huge)))).toContain('Vaswani');
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

/**
 * The shape of a modern arXiv paper: references in the middle, appendix after.
 * Everything here is drawn from a real reader session that produced garbage.
 */
describe('parseBibliography — a paper with an appendix', () => {
  const PAPER = [
    'We build on prior work (Vaswani et al., 2017).',
    'References',
    'Vaswani, A., Shazeer, N., Parmar, N. Attention is all you need. In Advances in',
    'Neural Information Processing Systems, 2017.',
    'Ho, J., Jain, A., Abbeel, P. Denoising diffusion probabilistic models. In NeurIPS',
    'Conference, 2020.',
    'Q. Sun, P. Hong, T. D. Pala, D. Ghosal, S. Poria. Emma-x: An embodied multimodal',
    'action model. arXiv:2412.11974, 2024.',
    'A. Zha, C. Zhao, Z. Zhu, P. Arbelaez, G. Bertasius, D. Crandall, D. Damen.',
    'Ego-exo4d. In CVPR, 2024.',
    'A Appendix',
    'A.1 Implementation details',
    'Here, AdaRMS denotes RMS normalization followed by the time-dependent affine',
    'transform used throughout the network.',
    'FPS, camera configuration, and action/state dimensions. Figure 13 presents the',
    'distribution of action verbs before and after the language annotation pipeline.',
    'However, we observe that the model converges faster with this schedule.',
  ].join('\n');

  const entries = () => allReferences(parseBibliography(PAPER)).map((r) => r.text);

  // The list was showing two of four. `allReferences` was rebuilt from the two
  // lookup maps, and an unnumbered entry only lands in those if it has both a
  // surname and a year — so anything else silently vanished from the list the
  // reader actually reads.
  it('keeps every entry, not just the ones a citation marker could resolve', () => {
    expect(entries()).toHaveLength(4);
  });

  it('keeps them in the order they appear', () => {
    expect(entries()[0]).toContain('Vaswani');
    expect(entries()[3]).toContain('Zha');
  });

  // The bibliography ran to the end of the document, so appendix prose was
  // parsed as references: "Here, AdaRMS denotes…" and "FPS, camera
  // configuration…" both appeared in the list as papers to open.
  it('stops at the appendix instead of swallowing it', () => {
    const text = entries().join(' | ');

    expect(text).not.toContain('AdaRMS');
    expect(text).not.toContain('camera configuration');
    expect(text).not.toContain('However');
  });

  // A continuation line beginning "Conference, 2020." was treated as the start
  // of a new entry, which both truncated the real one and produced an entry
  // beginning mid-sentence.
  it('does not start a new entry on a wrapped line that merely begins with a word and a comma', () => {
    const ho = entries().find((t) => t.startsWith('Ho,'));

    expect(ho).toContain('Conference, 2020');
    expect(entries().some((t) => t.startsWith('Conference,'))).toBe(false);
  });

  it('still resolves an author-year citation into the right entry', () => {
    const [ref] = resolveCitation(parseBibliography(PAPER), { author: 'Vaswani', year: 2017 });

    expect(ref.text).toContain('Attention is all you need');
  });
});

describe('parseBibliography — no references section', () => {
  it('returns an empty index', () => {
    expect(parseBibliography('Just some prose with no bibliography at all.').isEmpty).toBe(true);
  });
});
