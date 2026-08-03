import { describe, expect, it } from 'vitest';
import type { SourceRef } from '../tools';
import { buildCitationRule, renderSourceList, resolveCitations } from './citations';

const source = (id: string, url: string, title = `Title ${id}`): SourceRef => ({
  id,
  kind: 'highlight',
  title,
  url,
});

const sources = [source('S1', 'https://a.example/one'), source('S2', 'https://b.example/two')];

describe('resolveCitations', () => {
  it('links a valid marker to the source it names', () => {
    const out = resolveCitations('You highlighted attention [S1].', sources);
    expect(out.text).toBe('You highlighted attention [[S1]](https://a.example/one).');
    expect(out.cited.map((s) => s.id)).toEqual(['S1']);
    expect(out.fabricated).toBe(0);
  });

  it('STRIPS a marker that references nothing, and counts it', () => {
    // The whole guarantee: an id the loop never minted cannot be rendered.
    const out = resolveCitations('Per the literature [S7], attention scales.', sources);
    expect(out.text).not.toContain('S7');
    expect(out.fabricated).toBe(1);
    expect(out.cited).toEqual([]);
  });

  it('keeps the real citations in a mix of real and invented ones', () => {
    const out = resolveCitations('Both [S1] and [S9] agree.', sources);
    expect(out.text).toContain('https://a.example/one');
    expect(out.text).not.toContain('S9');
    expect(out.fabricated).toBe(1);
    expect(out.cited.map((s) => s.id)).toEqual(['S1']);
  });

  it('lists each cited source once even when cited repeatedly', () => {
    const out = resolveCitations('[S1] says this, and [S1] also says that.', sources);
    expect(out.cited.map((s) => s.id)).toEqual(['S1']);
  });

  it('reports cited sources in id order regardless of citation order', () => {
    const out = resolveCitations('First [S2], then [S1].', sources);
    expect(out.cited.map((s) => s.id)).toEqual(['S1', 'S2']);
  });

  it('strips a bare URL that came from nowhere', () => {
    // The most convincing possible fabrication: a plausible-looking arXiv link.
    const out = resolveCitations('See https://arxiv.org/abs/2406.09246 for details.', sources);
    expect(out.text).toBe('See [link removed — not from a source I checked] for details.');
    expect(out.strippedUrls).toBe(1);
  });

  it('leaves a bare URL alone when a tool really returned it', () => {
    const out = resolveCitations('See https://a.example/one for details.', sources);
    expect(out.text).toBe('See https://a.example/one for details.');
    expect(out.strippedUrls).toBe(0);
  });

  it('reduces an unverifiable markdown link to its text, keeping the sentence', () => {
    const out = resolveCitations('Read [the paper](https://evil.example/x) first.', sources);
    expect(out.text).toBe('Read the paper first.');
    expect(out.strippedUrls).toBe(1);
  });

  it('keeps a markdown link whose target is a real source', () => {
    const out = resolveCitations('Read [the paper](https://b.example/two) first.', sources);
    expect(out.text).toBe('Read [the paper](https://b.example/two) first.');
    expect(out.strippedUrls).toBe(0);
  });

  it('does not strip the links it just created from markers', () => {
    // Ordering guard: the URL sweep must run after markers are linked, or it
    // would tear out the citations that were legitimately just added.
    const out = resolveCitations('Attention [S1] and memory [S2].', sources);
    expect(out.text).toContain('(https://a.example/one)');
    expect(out.text).toContain('(https://b.example/two)');
    expect(out.strippedUrls).toBe(0);
  });

  it('tolerates trailing punctuation on an otherwise valid URL', () => {
    const out = resolveCitations('See https://a.example/one.', sources);
    expect(out.strippedUrls).toBe(0);
  });

  it('strips everything when the turn gathered no sources at all', () => {
    const out = resolveCitations('As shown [S1], see https://x.example/y.', []);
    expect(out.text).not.toContain('S1');
    expect(out.text).not.toContain('https://x.example/y');
    expect(out.fabricated).toBe(1);
    expect(out.strippedUrls).toBe(1);
  });

  it('leaves an ordinary answer untouched', () => {
    const plain = 'You have three open tasks.';
    expect(resolveCitations(plain, sources)).toMatchObject({
      text: plain,
      fabricated: 0,
      strippedUrls: 0,
      cited: [],
    });
  });

  it('tidies the space a removed marker leaves behind', () => {
    const out = resolveCitations('Attention scales [S7] .', sources);
    expect(out.text).toBe('Attention scales.');
  });
});

describe('buildCitationRule', () => {
  it('says nothing when there is nothing to cite', () => {
    // Asking for citations with no sources is an invitation to invent an id.
    expect(buildCitationRule([])).toBe('');
  });

  it('forbids inventing ids and writing URLs when sources exist', () => {
    const rule = buildCitationRule(sources);
    expect(rule).toContain('never invent one');
    expect(rule).toContain('never write a URL of your own');
  });
});

describe('renderSourceList', () => {
  it('is empty when nothing was cited', () => {
    expect(renderSourceList([])).toBe('');
  });

  it('lists only what was cited, not everything gathered', () => {
    const footer = renderSourceList([sources[1]]);
    expect(footer).toContain('[S2] [Title S2](https://b.example/two)');
    expect(footer).not.toContain('S1');
  });
});
