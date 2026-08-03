import { describe, expect, it } from 'vitest';
import type { Reference } from '../../shared/bibliography';
import type { DocCitations } from '../../shared/docCitations';
import type { Paper } from '../../shared/types';
import { indexKnownRefs, knownTargetFor, refMatchKey } from './citationLinks';

const NOW = 1_700_000_000_000;

function ref(link: string | null, text = 'An entry'): Reference {
  return { label: '1', text, link, authorKey: null, year: null };
}

function paper(over: Partial<Paper> = {}): Paper {
  return {
    id: 'p1',
    deckId: 'd1',
    title: 'Attention Is All You Need',
    authors: 'Vaswani et al.',
    venue: 'NeurIPS',
    year: 2017,
    citations: null,
    url: 'https://arxiv.org/abs/1706.03762',
    abstract: '',
    relevance: '',
    status: 'reading',
    progressPercent: 40,
    leftOff: '',
    addedAt: NOW,
    updatedAt: NOW,
    lastReadAt: null,
    ...over,
  };
}

function doc(over: Partial<DocCitations> = {}): DocCitations {
  return {
    docKey: 'arxiv:1706.03762',
    docUrl: 'https://arxiv.org/abs/1706.03762',
    title: 'Some PDF I opened',
    refKeys: [],
    indexedAt: NOW,
    ...over,
  };
}

describe('refMatchKey', () => {
  // The same work cited as an abs page and as a versioned PDF must read as one
  // target, or half the citations to a paper you own look like ones you don't.
  it('collapses abs, pdf and versioned links to one key', () => {
    expect(refMatchKey(ref('https://arxiv.org/abs/1706.03762'))).toBe(
      refMatchKey(ref('https://arxiv.org/pdf/1706.03762v5')),
    );
  });

  it('returns null for an entry with no link at all', () => {
    expect(refMatchKey(ref(null))).toBe(null);
  });
});

describe('indexKnownRefs', () => {
  it('recognises a citation of a tracked paper', () => {
    const known = indexKnownRefs([paper()], {});
    const target = knownTargetFor(ref('https://arxiv.org/pdf/1706.03762v5'), known);

    expect(target).toMatchObject({ kind: 'paper', title: 'Attention Is All You Need' });
  });

  it('recognises a citation of something merely opened', () => {
    const known = indexKnownRefs([], { d: doc() });

    expect(knownTargetFor(ref('https://arxiv.org/abs/1706.03762'), known)).toMatchObject({
      kind: 'read',
    });
  });

  // A tracked paper carries status, progress and a deck; an opened document
  // carries only the fact that it was opened. Linking to the poorer record
  // when both exist throws away everything the reader actually wants.
  it('prefers the tracked paper when both describe the same work', () => {
    const known = indexKnownRefs([paper()], { d: doc() });

    expect(knownTargetFor(ref('https://arxiv.org/abs/1706.03762'), known)?.kind).toBe('paper');
  });

  it('reports nothing for a citation of something never seen', () => {
    const known = indexKnownRefs([paper()], {});

    expect(knownTargetFor(ref('https://arxiv.org/abs/2006.11239'), known)).toBe(null);
  });

  it('reports nothing for an entry with no link, rather than guessing from the title', () => {
    const known = indexKnownRefs([paper()], {});

    expect(knownTargetFor(ref(null, 'Vaswani et al. Attention is all you need.'), known)).toBe(null);
  });
});
