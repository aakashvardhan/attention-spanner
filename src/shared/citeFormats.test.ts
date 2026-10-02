import { describe, expect, it } from 'vitest';
import { formatCitation, type CiteSource } from './citeFormats';

const attention: CiteSource = {
  title: 'Attention Is All You Need',
  authors: 'Ashish Vaswani, Noam Shazeer, Niki Parmar',
  venue: 'NeurIPS',
  year: 2017,
  url: 'https://arxiv.org/abs/1706.03762',
};

describe('formatCitation', () => {
  it('APA: surname + initials, ampersand before the last author', () => {
    expect(formatCitation(attention, 'apa')).toBe(
      'Vaswani, A., Shazeer, N., & Parmar, N. (2017). Attention Is All You Need. NeurIPS. https://arxiv.org/abs/1706.03762',
    );
  });

  it('MLA: et al. past two authors', () => {
    expect(formatCitation(attention, 'mla')).toBe(
      'Vaswani, Ashish, et al. “Attention Is All You Need.” NeurIPS, 2017.',
    );
  });

  it('MLA: two authors are both named', () => {
    const two = { ...attention, authors: 'Ashish Vaswani, Noam Shazeer' };
    expect(formatCitation(two, 'mla')).toBe(
      'Vaswani, Ashish, and Noam Shazeer. “Attention Is All You Need.” NeurIPS, 2017.',
    );
  });

  it('BibTeX: key from surname, year and first title word; "and"-joined authors', () => {
    expect(formatCitation(attention, 'bibtex')).toBe(
      [
        '@article{vaswani2017attention,',
        '  title={Attention Is All You Need},',
        '  author={Vaswani, Ashish and Shazeer, Noam and Parmar, Niki},',
        '  journal={NeurIPS},',
        '  year={2017},',
        '  url={https://arxiv.org/abs/1706.03762}',
        '}',
      ].join('\n'),
    );
  });

  it('missing fields are left out, not invented', () => {
    const bare: CiteSource = { title: 'Untitled draft', authors: '', venue: '', year: null, url: '' };
    expect(formatCitation(bare, 'apa')).toBe('(n.d.). Untitled draft.');
    expect(formatCitation(bare, 'mla')).toBe('“Untitled draft.”');
    expect(formatCitation(bare, 'bibtex')).toBe('@article{anonuntitled,\n  title={Untitled draft}\n}');
  });
});
