import { describe, expect, it } from 'vitest';
import {
  extractIdentifiers,
  openAlexId,
  openAlexTitleQuery,
  pickTitleMatch,
  resolveWork,
  scanIdentifiers,
  titleSimilarity,
  type OpenAlexWork,
  type WorkLookup,
} from './workResolve';

/** The real record, trimmed to what the resolver reads. */
function work(over: Partial<OpenAlexWork> = {}): OpenAlexWork {
  return {
    id: 'https://openalex.org/W3036167779',
    display_name: 'Denoising Diffusion Probabilistic Models',
    publication_year: 2020,
    referenced_works: ['https://openalex.org/W967544008'],
    ...over,
  };
}

/**
 * A provider that answers from a table. Keyed exactly as `resolveWork` builds
 * its keys, so a wrong key shape shows up as a miss rather than silently
 * passing.
 */
function lookup(
  byId: Record<string, OpenAlexWork> = {},
  byTitle: OpenAlexWork[] = [],
): WorkLookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async byId(key) {
      calls.push(`byId:${key}`);
      return byId[key] ?? null;
    },
    async byTitle(title) {
      calls.push(`byTitle:${title}`);
      return byTitle;
    },
  };
}

describe('extractIdentifiers', () => {
  it('reads an arXiv id out of abs, pdf and versioned links', () => {
    for (const url of [
      'https://arxiv.org/abs/2006.11239',
      'https://arxiv.org/pdf/2006.11239.pdf',
      'https://arxiv.org/abs/2006.11239v3',
    ]) {
      expect(extractIdentifiers({ url }).arxiv).toBe('2006.11239');
    }
  });

  it('reads a DOI out of a doi.org link', () => {
    const ids = extractIdentifiers({ url: 'https://doi.org/10.1038/s41586-020-2012-7' });
    expect(ids.doi).toBe('10.1038/s41586-020-2012-7');
  });

  it('reads a PubMed id out of a pubmed link', () => {
    expect(extractIdentifiers({ url: 'https://pubmed.ncbi.nlm.nih.gov/32015507' }).pmid).toBe(
      '32015507',
    );
  });

  it('strips sentence punctuation off a DOI found in prose', () => {
    const ids = extractIdentifiers({ text: 'As shown in 10.1038/s41586-020-2012-7.' });
    expect(ids.doi).toBe('10.1038/s41586-020-2012-7');
  });

  it('takes an arXiv id from text only where something marks it as one', () => {
    expect(extractIdentifiers({ text: 'see arXiv:2006.11239 for details' }).arxiv).toBe(
      '2006.11239',
    );
    // The precision rule Phase 4 depends on: a bare decimal in prose is a
    // version number, a date range or a price far more often than a paper.
    expect(extractIdentifiers({ text: 'revenue rose to 2006.11239 last year' }).arxiv).toBeNull();
  });

  it('prefers what the URL asserts over what the body mentions', () => {
    const ids = extractIdentifiers({
      url: 'https://arxiv.org/abs/2006.11239',
      text: 'this builds on arXiv:1706.03762',
    });
    expect(ids.arxiv).toBe('2006.11239');
  });

  it('returns nulls and an empty title for a page with no identity', () => {
    expect(extractIdentifiers({ url: 'https://example.com/blog/post' })).toEqual({
      doi: null,
      arxiv: null,
      pmid: null,
      title: '',
    });
  });
});

describe('scanIdentifiers', () => {
  it('finds every distinct identifier, in reading order, with its evidence', () => {
    const text = 'We follow arXiv:1706.03762 and 10.1038/s41586-020-2012-7, plus PMID: 32015507.';
    const hits = scanIdentifiers(text);
    expect(hits.map((h) => [h.kind, h.value])).toEqual([
      ['arxiv', '1706.03762'],
      ['doi', '10.1038/s41586-020-2012-7'],
      ['pmid', '32015507'],
    ]);
    // The span is what a user clicks an edge to see, so it has to be the real text.
    expect(text.slice(hits[0].at, hits[0].at + hits[0].match.length)).toBe(hits[0].match);
  });

  it('reports a repeated identifier once', () => {
    const hits = scanIdentifiers('arXiv:2006.11239 ... and again arxiv.org/abs/2006.11239');
    expect(hits).toHaveLength(1);
  });

  it('finds nothing in text that names nothing', () => {
    expect(scanIdentifiers('a video about machine learning, generally')).toEqual([]);
  });
});

describe('titleSimilarity', () => {
  it('scores an exact title 1', () => {
    expect(titleSimilarity('Attention Is All You Need', 'Attention Is All You Need')).toBe(1);
  });

  it('ignores case and punctuation', () => {
    expect(titleSimilarity('Attention Is All You Need', 'attention is all you need!')).toBe(1);
  });

  it('survives site cruft appended to a page title', () => {
    expect(
      titleSimilarity('Attention Is All You Need | arXiv', 'Attention Is All You Need'),
    ).toBeGreaterThan(0.85);
  });

  /**
   * The measured trap, and the reason the floor sits where it does. OpenAlex
   * returns this paper first for that query; believing the ranking would file a
   * citation under the wrong work.
   */
  it('scores the observed ranking trap far below the floor', () => {
    const score = titleSimilarity(
      'diffusion models for inpainting',
      'RePaint: Inpainting using Denoising Diffusion Probabilistic Models',
    );
    expect(score).toBeCloseTo(0.545, 2);
  });

  it('scores an empty title 0 rather than dividing by zero', () => {
    expect(titleSimilarity('', 'Anything At All')).toBe(0);
  });
});

describe('pickTitleMatch', () => {
  it('chooses by overlap, not by rank', () => {
    const hit = pickTitleMatch('Denoising Diffusion Probabilistic Models', [
      work({ display_name: 'RePaint: Inpainting using Denoising Diffusion Probabilistic Models' }),
      work({ display_name: 'Denoising Diffusion Probabilistic Models' }),
    ]);
    expect(hit?.work.display_name).toBe('Denoising Diffusion Probabilistic Models');
    expect(hit?.score).toBe(1);
  });

  it('returns nothing when the best candidate is still a guess', () => {
    expect(
      pickTitleMatch('diffusion models for inpainting', [
        work({ display_name: 'RePaint: Inpainting using Denoising Diffusion Probabilistic Models' }),
      ]),
    ).toBeNull();
  });

  it('skips candidates the index returned without a title', () => {
    expect(pickTitleMatch('Attention Is All You Need', [work({ display_name: null, title: null })])).toBeNull();
  });

  /**
   * A known limit, pinned rather than hidden.
   *
   * A title that is a strict subset of another scores high: "Denoising
   * Diffusion Probabilistic Models" against "Improved Denoising Diffusion
   * Probabilistic Models" is 0.889, over the floor. No threshold fixes this —
   * legitimate site cruft ("… | arXiv") scores 0.909, two hundredths away, so
   * raising the gate to exclude the first would exclude the second.
   *
   * What actually protects the result is choosing by score across the whole
   * candidate page: when the true paper is indexed it scores 1.0 and wins. The
   * exposure is therefore narrow but real — a work absent from OpenAlex whose
   * title is a subset of one that is present will resolve to the wrong id, at
   * ~0.89 confidence and method 'title'. That is precisely why a fuzzy hit is
   * marked, and why callers minting edges must gate on method.
   */
  it('lets the true paper beat a superset title when both are on the page', () => {
    const candidates = [
      work({ id: 'https://openalex.org/W3122887982', display_name: 'Improved Denoising Diffusion Probabilistic Models' }),
      work({ id: 'https://openalex.org/W3036167779', display_name: 'Denoising Diffusion Probabilistic Models' }),
    ];
    const hit = pickTitleMatch('Denoising Diffusion Probabilistic Models', candidates);
    expect(openAlexId(hit!.work)).toBe('W3036167779');
  });

  it('records that a lone superset title still clears the floor', () => {
    const hit = pickTitleMatch('Denoising Diffusion Probabilistic Models', [
      work({ display_name: 'Improved Denoising Diffusion Probabilistic Models' }),
    ]);
    expect(hit?.score).toBeCloseTo(0.889, 2);
  });
});

describe('openAlexTitleQuery', () => {
  /**
   * Pins a 400 measured against the live API. A comma in a filter value is read
   * as a filter separator, and percent-encoding it does not help — the edge
   * proxy decodes first. "Attention, Learn to Solve Routing Problems!" is a
   * real paper and a real reproduction.
   */
  it('removes the punctuation OpenAlex parses as filter syntax', () => {
    expect(openAlexTitleQuery('Attention, Learn to Solve Routing Problems!')).toBe(
      'attention learn to solve routing problems',
    );
  });

  it('removes the pipe that would otherwise read as OR', () => {
    expect(openAlexTitleQuery('Foo | Bar')).toBe('foo bar');
  });

  it('is empty for a title with nothing searchable in it', () => {
    expect(openAlexTitleQuery('  ,,, ')).toBe('');
  });
});

describe('openAlexId', () => {
  it('takes the bare id out of the URL form', () => {
    expect(openAlexId(work())).toBe('W3036167779');
  });

  it('rejects anything that is not a work id', () => {
    expect(openAlexId(work({ id: 'https://openalex.org/A5023888391' }))).toBeNull();
    expect(openAlexId(work({ id: undefined }))).toBeNull();
  });
});

describe('resolveWork', () => {
  it('resolves a DOI exactly', async () => {
    const api = lookup({ 'doi:10.1038/s41586-020-2012-7': work() });
    const res = await resolveWork(
      { url: 'https://doi.org/10.1038/s41586-020-2012-7' },
      api,
    );
    expect(res).toMatchObject({ canonicalId: 'W3036167779', confidence: 1, method: 'doi' });
    // The raw record is kept so Phase 2 reads the reference list without asking again.
    expect(res.raw?.referenced_works).toEqual(['https://openalex.org/W967544008']);
  });

  it('resolves an arXiv id through the DataCite DOI', async () => {
    const api = lookup({ 'doi:10.48550/arXiv.2006.11239': work() });
    const res = await resolveWork({ url: 'https://arxiv.org/abs/2006.11239v3' }, api);
    expect(res).toMatchObject({ canonicalId: 'W3036167779', confidence: 1, method: 'arxiv' });
  });

  it('resolves a PubMed id', async () => {
    const api = lookup({ 'pmid:32015507': work() });
    const res = await resolveWork({ url: 'https://pubmed.ncbi.nlm.nih.gov/32015507' }, api);
    expect(res.method).toBe('pmid');
    expect(res.confidence).toBe(1);
  });

  it('marks a title hit as fuzzy and never gives it full confidence', async () => {
    const api = lookup({}, [work()]);
    const res = await resolveWork({ title: 'Denoising Diffusion Probabilistic Models' }, api);
    expect(res.method).toBe('title');
    expect(res.canonicalId).toBe('W3036167779');
    // A perfect string match is still a search result, not an assertion.
    expect(res.confidence).toBeLessThan(1);
    expect(res.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('misses rather than guessing when the only candidate is a near neighbour', async () => {
    const api = lookup({}, [
      work({ display_name: 'RePaint: Inpainting using Denoising Diffusion Probabilistic Models' }),
    ]);
    const res = await resolveWork({ title: 'diffusion models for inpainting' }, api);
    expect(res).toEqual({ canonicalId: null, confidence: 0, method: 'none', raw: null });
  });

  it('misses cleanly on a page with no identity at all', async () => {
    const res = await resolveWork({ url: 'https://example.com/blog/post' }, lookup());
    expect(res).toEqual({ canonicalId: null, confidence: 0, method: 'none', raw: null });
  });

  it('falls through a DOI the index has not ingested to the arXiv id', async () => {
    const api = lookup({ 'doi:10.48550/arXiv.2006.11239': work() });
    const res = await resolveWork(
      {
        url: 'https://arxiv.org/abs/2006.11239',
        text: 'published as 10.5555/not-yet-indexed',
      },
      api,
    );
    expect(res.method).toBe('arxiv');
    expect(api.calls).toEqual([
      'byId:doi:10.5555/not-yet-indexed',
      'byId:doi:10.48550/arXiv.2006.11239',
    ]);
  });

  it('treats a network failure as a miss for that identifier rather than throwing', async () => {
    const api: WorkLookup = {
      async byId() {
        throw new Error('offline');
      },
      async byTitle() {
        return [work()];
      },
    };
    const res = await resolveWork(
      { url: 'https://arxiv.org/abs/2006.11239', title: 'Denoising Diffusion Probabilistic Models' },
      api,
    );
    // The identifier lookup failed, so the title carried it — and said so.
    expect(res.method).toBe('title');
  });

  it('never spends a title search when the caller opted out', async () => {
    const api = lookup({}, [work()]);
    const res = await resolveWork(
      { title: 'Denoising Diffusion Probabilistic Models' },
      api,
      { allowTitleSearch: false },
    );
    expect(res.canonicalId).toBeNull();
    expect(api.calls).toEqual([]);
  });
});
