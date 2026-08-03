import { describe, expect, it } from 'vitest';
import type { DiscoveredPaper } from './alphaxiv';
import { normalizeTitle, paperDraftFromDiscovered, paperMatchKey, parsePaperRef } from './papers';

describe('parsePaperRef', () => {
  it('recognizes arXiv abs/pdf/versioned/.pdf as the same id', () => {
    for (const input of [
      'https://arxiv.org/abs/2006.11239',
      'https://arxiv.org/pdf/2006.11239',
      'https://arxiv.org/pdf/2006.11239.pdf',
      'https://arxiv.org/abs/2006.11239v3',
      '2006.11239',
    ]) {
      expect(parsePaperRef(input)).toBe('arXiv:2006.11239');
    }
  });

  it('recognizes legacy arXiv ids and DOIs', () => {
    expect(parsePaperRef('hep-th/9901001')).toBe('arXiv:hep-th/9901001');
    expect(parsePaperRef('https://doi.org/10.1145/3292500.3330701')).toBe(
      'DOI:10.1145/3292500.3330701',
    );
  });

  it('falls back to URL for other links, null for junk', () => {
    expect(parsePaperRef('https://example.com/paper')).toBe('URL:https://example.com/paper');
    expect(parsePaperRef('just some text')).toBeNull();
    expect(parsePaperRef('')).toBeNull();
  });
});

describe('paperMatchKey', () => {
  it('collapses arXiv abs / pdf / versioned to one key', () => {
    const key = paperMatchKey('https://arxiv.org/abs/2006.11239');
    expect(paperMatchKey('https://arxiv.org/pdf/2006.11239.pdf')).toBe(key);
    expect(paperMatchKey('https://arxiv.org/abs/2006.11239v2')).toBe(key);
  });

  it('normalizes plain URLs (www, query, hash, trailing slash)', () => {
    const a = paperMatchKey('https://example.com/papers/x/');
    expect(paperMatchKey('http://www.example.com/papers/x?ref=1#sec2')).toBe(a);
    expect(paperMatchKey('https://example.com/papers/y')).not.toBe(a);
  });

  it('returns null for unmatchable input', () => {
    expect(paperMatchKey('not a url')).toBeNull();
  });
});

describe('paperDraftFromDiscovered', () => {
  const discovered: DiscoveredPaper = {
    id: '2406.09246',
    title: '  Learning to Act  ',
    url: 'https://www.alphaxiv.org/abs/2406.09246',
    published: '2024-06-13',
    authors: 'Jane Doe, John Roe',
    votes: 42,
    abstract: 'We propose a method.',
  };

  it('maps a result to a to-read draft: trims the title, takes the year', () => {
    expect(paperDraftFromDiscovered(discovered, 'deck-1')).toEqual({
      deckId: 'deck-1',
      title: 'Learning to Act',
      authors: 'Jane Doe, John Roe',
      venue: '',
      year: 2024,
      citations: null,
      url: 'https://www.alphaxiv.org/abs/2406.09246',
      abstract: 'We propose a method.',
      relevance: '',
      status: 'to-read',
      progressPercent: 0,
      leftOff: '',
    });
  });

  it('leaves year null when the result carried no date', () => {
    expect(paperDraftFromDiscovered({ ...discovered, published: '' }, 'deck-1').year).toBeNull();
  });
});

describe('normalizeTitle', () => {
  it('collapses case, punctuation, and whitespace', () => {
    expect(normalizeTitle('Learning Fine-Grained  Bimanual Manipulation')).toBe(
      normalizeTitle('learning fine grained bimanual manipulation'),
    );
    expect(normalizeTitle('ALOHA: A Low-cost System')).toBe('aloha a low cost system');
  });

  it('keeps distinct titles distinct', () => {
    expect(normalizeTitle('Attention Is All You Need')).not.toBe(
      normalizeTitle('Attention Is Not All You Need'),
    );
  });
});
