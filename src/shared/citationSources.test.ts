import { describe, expect, it } from 'vitest';
import type { ExternalPaper } from './citations';
import {
  collect,
  localSource,
  openAlexKey,
  openAlexTopics,
  parseS2Rows,
  referencesFromText,
  SourceUnavailable,
  type CitationEnv,
  type CitationSource,
} from './citationSources';
import type { DocCitations } from './docCitations';

const NOW = 1_700_000_000_000;

function env(over: Partial<CitationEnv> = {}): CitationEnv {
  return { semanticScholarKey: '', docCitations: {}, ...over };
}

function doc(over: Partial<DocCitations> = {}): DocCitations {
  return {
    docKey: 'arxiv:9999.00001',
    docUrl: 'https://arxiv.org/abs/9999.00001',
    title: 'A paper that cites yours',
    refKeys: ['arxiv:1706.03762'],
    indexedAt: NOW,
    ...over,
  };
}

/** A source that records whether it was asked, so chain order is observable. */
function fake(
  id: CitationSource['id'],
  behaviour: 'ok' | 'fail',
  calls: string[],
  supports = { references: true, citations: true },
): CitationSource {
  const run = async (relation: ExternalPaper['relation']) => {
    calls.push(id);
    if (behaviour === 'fail') throw new SourceUnavailable('nope');
    return [
      {
        s2Id: `${id}-1`,
        title: `From ${id}`,
        authors: '',
        venue: '',
        year: null,
        citations: null,
        url: 'https://example.test/x',
        matchKey: null,
        topics: [],
        relation,
      },
    ];
  };
  return {
    id,
    supports,
    available: () => true,
    fetchReferences: () => run('reference'),
    fetchCitations: () => run('citation'),
  };
}

describe('openAlexKey', () => {
  it('turns a DOI into a direct lookup', () => {
    expect(openAlexKey('DOI:10.1145/3292500')).toBe('doi:10.1145/3292500');
  });

  // arXiv papers carry a DataCite DOI, which is an exact identifier. A title
  // search would be the alternative, and a fallback that quietly returns a
  // *different* paper's references is worse than no fallback at all.
  it('turns an arXiv id into its DataCite DOI', () => {
    expect(openAlexKey('arXiv:2406.09246')).toBe('doi:10.48550/arXiv.2406.09246');
  });

  it('reports nothing for a reference with no exact identifier', () => {
    expect(openAlexKey('URL:https://example.test/paper')).toBe(null);
  });
});

describe('parseS2Rows', () => {
  it('unwraps the citedPaper envelope and builds an arXiv link', () => {
    const payload = {
      data: [
        {
          citedPaper: {
            paperId: 'abc',
            title: 'A Paper',
            year: 2020,
            venue: 'ICML',
            citationCount: 12,
            authors: [{ name: 'Ada' }, { name: 'Grace' }],
            externalIds: { ArXiv: '2006.11239' },
          },
        },
      ],
    };

    expect(parseS2Rows(payload, 'reference')[0]).toMatchObject({
      s2Id: 'abc',
      title: 'A Paper',
      authors: 'Ada, Grace',
      url: 'https://arxiv.org/abs/2006.11239',
      matchKey: 'arxiv:2006.11239',
    });
  });

  it('prefers a DOI link when there is no arXiv id', () => {
    const payload = {
      data: [{ citingPaper: { paperId: 'x', title: 'T', externalIds: { DOI: '10.1/z' } } }],
    };

    expect(parseS2Rows(payload, 'citation')[0].url).toBe('https://doi.org/10.1/z');
  });

  // Semantic Scholar returns null-filled placeholders for records it holds but
  // will not disclose. A nameless node is worse than a missing one.
  it('skips rows with no id or no title', () => {
    const payload = {
      data: [
        { citedPaper: { paperId: null, title: 'No id' } },
        { citedPaper: { paperId: 'y', title: '  ' } },
        { citedPaper: { paperId: 'z', title: 'Real' } },
      ],
    };

    expect(parseS2Rows(payload, 'reference').map((p) => p.s2Id)).toEqual(['z']);
  });

  it('returns nothing for a shape it does not recognise', () => {
    expect(parseS2Rows({ nope: true }, 'reference')).toEqual([]);
  });
});

describe('openAlexTopics', () => {
  // Verified against the live API: primary_topic carries a specific topic
  // inside a subfield, so these are parent and child rather than two peers.
  const work = {
    primary_topic: {
      display_name: 'Generative Adversarial Networks and Image Synthesis',
      subfield: { display_name: 'Computer Vision and Pattern Recognition' },
    },
  };

  it('puts the subfield first, because that is what groups a reference list', () => {
    expect(openAlexTopics(work)).toEqual([
      'computer vision and pattern recognition',
      'generative adversarial networks and image synthesis',
    ]);
  });

  // normalizeTag caps at five words to stop a model emitting a sentence; these
  // come from a curated vocabulary and must survive intact.
  it('does not truncate a real taxonomy label', () => {
    expect(openAlexTopics(work)[1]).toBe(
      'generative adversarial networks and image synthesis',
    );
  });

  it('falls back to the first of the topics array', () => {
    expect(openAlexTopics({ topics: [{ display_name: 'Neuroscience' }] })).toEqual(['neuroscience']);
  });

  // The field names are external and could change. A shape we do not recognise
  // has to mean "no topic", not an exception on every reference in the list.
  it('reports nothing for a work with no topic fields at all', () => {
    expect(openAlexTopics({})).toEqual([]);
    expect(openAlexTopics({ primary_topic: null })).toEqual([]);
    expect(openAlexTopics({ primary_topic: { subfield: null } })).toEqual([]);
  });

  it('collapses a topic that is its own subfield to one label', () => {
    const same = { primary_topic: { display_name: 'Neuroscience', subfield: { display_name: 'Neuroscience' } } };

    expect(openAlexTopics(same)).toEqual(['neuroscience']);
  });
});

describe('referencesFromText', () => {
  it('turns a bibliography into references, deduplicated', () => {
    const text = [
      'Body.',
      'References',
      '[1] Someone. A paper. arXiv:1706.03762, 2017.',
      '[2] Someone. The same paper. https://arxiv.org/pdf/1706.03762v3.pdf, 2017.',
      '[3] Other. Another. doi:10.1145/3292500.3330701, 2019.',
    ].join('\n');

    expect(referencesFromText(text, 10).map((p) => p.s2Id)).toEqual([
      'arxiv:1706.03762',
      'doi:10.1145/3292500.3330701',
    ]);
  });

  it('caps how many it takes', () => {
    const entries = Array.from(
      { length: 20 },
      (_, i) => `[${i + 1}] A. Paper. arXiv:24${String(i).padStart(2, '0')}.11111, 2024.`,
    );
    const text = ['Body.', 'References', ...entries].join('\n');

    expect(referencesFromText(text, 5)).toHaveLength(5);
  });
});

describe('localSource', () => {
  it('answers "who cites this" from documents already read', async () => {
    const found = await localSource.fetchCitations(
      'arXiv:1706.03762',
      env({ docCitations: { a: doc() } }),
    );

    expect(found[0]).toMatchObject({ title: 'A paper that cites yours', relation: 'citation' });
  });

  // An empty list reads as "nothing cites this", which stops the chain and is
  // false — the honest answer is that this tier has nothing to say.
  it('reports unavailable rather than empty when it has no entry', () => {
    expect(localSource.available('arXiv:1706.03762', env())).toBe(false);
  });

  it('never claims to serve a paper\'s own reference list', () => {
    expect(localSource.supports.references).toBe(false);
  });
});

describe('collect', () => {
  it('stops at the first source that answers', async () => {
    const calls: string[] = [];
    const chain = [fake('local', 'ok', calls), fake('semantic-scholar', 'ok', calls)];
    const got = await collect('citations', 'arXiv:1', env(), chain);

    expect(calls).toEqual(['local']);
    expect(got.source).toBe('local');
  });

  it('moves past a source that fails', async () => {
    const calls: string[] = [];
    const chain = [fake('semantic-scholar', 'fail', calls), fake('openalex', 'ok', calls)];
    const got = await collect('references', 'arXiv:1', env(), chain);

    expect(calls).toEqual(['semantic-scholar', 'openalex']);
    expect(got.source).toBe('openalex');
  });

  // Skipping by direction is what keeps alphaXiv out of the backlink path.
  it('skips a source that does not serve the direction asked', async () => {
    const calls: string[] = [];
    const chain = [
      fake('openalex', 'ok', calls),
    ];
    const got = await collect('citations', 'arXiv:1', env(), chain);

    expect(calls).toEqual(['openalex']);
    expect(got.source).toBe('openalex');
  });

  it('reports nothing when every source is exhausted', async () => {
    const calls: string[] = [];
    const chain = [fake('semantic-scholar', 'fail', calls), fake('openalex', 'fail', calls)];

    expect(await collect('references', 'arXiv:1', env(), chain)).toEqual({
      papers: [],
      source: null,
    });
  });

  it('passes each attempt through the rate gate', async () => {
    const calls: string[] = [];
    const gated: string[] = [];
    const chain = [fake('semantic-scholar', 'fail', calls), fake('openalex', 'ok', calls)];
    await collect('references', 'arXiv:1', env(), chain, async (id) => {
      gated.push(id);
    });

    expect(gated).toEqual(['semantic-scholar', 'openalex']);
  });
});
