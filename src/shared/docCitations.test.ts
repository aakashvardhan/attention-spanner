import { describe, expect, it } from 'vitest';
import { parseBibliography } from './bibliography';
import { MAX_DOC_REF_KEYS } from './constants';
import { backlinksFor, pruneDocCitations, refKeysFrom, type DocCitations } from './docCitations';

const NOW = 1_700_000_000_000;

function doc(over: Partial<DocCitations> = {}): DocCitations {
  return {
    docKey: 'arxiv:1706.03762',
    docUrl: 'https://arxiv.org/abs/1706.03762',
    title: 'Attention Is All You Need',
    refKeys: [],
    indexedAt: NOW,
    ...over,
  };
}

/** A bibliography in the bracketed style, which parseBibliography prefers. */
function bibliography(...entries: string[]): string {
  return ['Body text.', 'References', entries.map((e, i) => `[${i + 1}] ${e}`).join(' ')].join('\n');
}

describe('refKeysFrom', () => {
  it('turns each linked entry into a stable match key', () => {
    const index = parseBibliography(
      bibliography(
        'Vaswani et al. Attention is all you need. arXiv:1706.03762, 2017.',
        'Devlin et al. BERT. doi:10.18653/v1/N19-1423, 2019.',
      ),
    );

    expect(refKeysFrom(index)).toEqual(['arxiv:1706.03762', 'doi:10.18653/v1/n19-1423']);
  });

  // The same work cited as an abs link and as a versioned pdf link is one
  // citation. Two keys would double-count it and make a backlink appear twice.
  it('collapses two spellings of the same reference into one key', () => {
    const index = parseBibliography(
      bibliography(
        'Someone. A paper. https://arxiv.org/abs/2006.11239, 2020.',
        'Someone. The same paper. https://arxiv.org/pdf/2006.11239v3.pdf, 2020.',
      ),
    );

    expect(refKeysFrom(index)).toEqual(['arxiv:2006.11239']);
  });

  // A key we cannot form is a citation we could never resolve. Manufacturing
  // one out of the title text would match some other paper entirely.
  it('skips an entry with no extractable link rather than inventing a key', () => {
    const index = parseBibliography(
      bibliography('Knuth. The Art of Computer Programming. Addison-Wesley, 1968.'),
    );

    expect(refKeysFrom(index)).toEqual([]);
  });

  it('caps a survey paper rather than storing its whole reference list', () => {
    const entries = Array.from(
      { length: MAX_DOC_REF_KEYS + 20 },
      (_, i) => `Author ${i}. A paper. arXiv:24${String(i).padStart(2, '0')}.11111, 2024.`,
    );

    expect(refKeysFrom(parseBibliography(bibliography(...entries)))).toHaveLength(MAX_DOC_REF_KEYS);
  });
});

describe('backlinksFor', () => {
  const attention = 'arxiv:1706.03762';

  it('finds the documents whose reference lists name this one, newest first', () => {
    const docs = {
      a: doc({ docKey: 'a', title: 'Older', refKeys: [attention], indexedAt: NOW - 1000 }),
      b: doc({ docKey: 'b', title: 'Newer', refKeys: [attention], indexedAt: NOW }),
      c: doc({ docKey: 'c', title: 'Unrelated', refKeys: ['arxiv:9999.99999'] }),
    };

    expect(backlinksFor(attention, docs).map((d) => d.title)).toEqual(['Newer', 'Older']);
  });

  // A paper's own bibliography routinely resolves back to it — self-citations,
  // an earlier preprint of the same work. "Cited by: itself" is a bug a reader
  // spots immediately.
  it('never reports a document as citing itself', () => {
    const docs = { [attention]: doc({ docKey: attention, refKeys: [attention] }) };

    expect(backlinksFor(attention, docs)).toEqual([]);
  });

  it('returns nothing for a document with no match key at all', () => {
    const docs = { a: doc({ docKey: 'a', refKeys: [attention] }) };

    expect(backlinksFor(null, docs)).toEqual([]);
  });
});

describe('pruneDocCitations', () => {
  // Half an index is worse than a small one: a document that survived with its
  // reference list truncated would silently under-report backlinks.
  it('evicts whole documents, oldest first', () => {
    const docs = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `d${i}`,
        doc({ docKey: `d${i}`, indexedAt: NOW - i * 1000 }),
      ]),
    );

    expect(Object.keys(pruneDocCitations(docs, 3)).sort()).toEqual(['d0', 'd1', 'd2']);
  });

  it('leaves an index under the cap untouched', () => {
    const docs = { a: doc({ docKey: 'a' }) };

    expect(pruneDocCitations(docs, 10)).toBe(docs);
  });
});
