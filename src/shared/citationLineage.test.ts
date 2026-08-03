import { describe, expect, it } from 'vitest';
import type { Reference } from './bibliography';
import { buildLineage, lineageStats, UNGROUPED, yearHomes } from './citationLineage';
import type { CitationExpansion, ExternalPaper } from './citations';
import { paperMatchKey } from './papers';

const NOW = 1_700_000_000_000;

function ref(link: string | null, text = 'Some author. A paper. 2020.', year: number | null = 2020): Reference {
  return { label: null, text, link, authorKey: null, year };
}

function paper(over: Partial<ExternalPaper> = {}): ExternalPaper {
  const url = over.url ?? 'https://arxiv.org/abs/2006.11239';
  return {
    s2Id: 's2',
    title: 'Denoising Diffusion Probabilistic Models',
    authors: 'Ho, Jain, Abbeel',
    venue: 'NeurIPS',
    year: 2020,
    citations: 900,
    url,
    matchKey: paperMatchKey(url),
    topics: ['computer vision and pattern recognition'],
    relation: 'reference',
    ...over,
  };
}

function expansion(papers: ExternalPaper[]): CitationExpansion {
  return {
    paperId: 'p1',
    fetchedAt: NOW,
    papers,
    partial: false,
    note: '',
    sources: { references: 'openalex', citations: 'openalex' },
  };
}

describe('buildLineage', () => {
  // The same work listed twice — once as a raw citation string, once with real
  // metadata — with nothing on screen saying they are the same paper.
  it('joins a bibliography entry and an index entry for the same work', () => {
    const groups = buildLineage(
      [ref('https://arxiv.org/abs/2006.11239')],
      expansion([paper()]),
      new Set(),
    );

    expect(lineageStats(groups).total).toBe(1);
  });

  it('prefers the real title over the raw citation string', () => {
    const groups = buildLineage(
      [ref('https://arxiv.org/abs/2006.11239', 'Ho, J., Jain, A., Abbeel, P. Denoising diff…')],
      expansion([paper()]),
      new Set(),
    );

    expect(groups[0].entries[0].title).toBe('Denoising Diffusion Probabilistic Models');
  });

  it('recognises the same work cited through a different link', () => {
    const groups = buildLineage(
      [ref('https://arxiv.org/pdf/2006.11239v3')],
      expansion([paper()]),
      new Set(),
    );

    expect(lineageStats(groups).total).toBe(1);
  });

  it('groups by the coarser of the source topics', () => {
    const groups = buildLineage(
      [],
      expansion([
        paper({ s2Id: 'a', url: 'https://arxiv.org/abs/1111.11111', topics: ['machine learning'] }),
        paper({ s2Id: 'b', url: 'https://arxiv.org/abs/2222.22222', topics: ['machine learning'] }),
        paper({ s2Id: 'c', url: 'https://arxiv.org/abs/3333.33333', topics: ['neuroscience'] }),
      ]),
      new Set(),
    );

    expect(groups.map((g) => [g.topic, g.entries.length])).toEqual([
      ['machine learning', 2],
      ['neuroscience', 1],
    ]);
  });

  // Reading order is the argument this view makes: top to bottom is the order
  // the ideas arrived in.
  it('orders a group oldest first', () => {
    const groups = buildLineage(
      [],
      expansion([
        paper({ s2Id: 'new', url: 'https://arxiv.org/abs/1111.11111', year: 2023 }),
        paper({ s2Id: 'old', url: 'https://arxiv.org/abs/2222.22222', year: 2014 }),
      ]),
      new Set(),
    );

    expect(groups[0].entries.map((e) => e.year)).toEqual([2014, 2023]);
  });

  it('sinks an undated entry rather than leading with it', () => {
    const groups = buildLineage(
      [],
      expansion([
        paper({ s2Id: 'none', url: 'https://arxiv.org/abs/1111.11111', year: null }),
        paper({ s2Id: 'dated', url: 'https://arxiv.org/abs/2222.22222', year: 2014 }),
      ]),
      new Set(),
    );

    expect(groups[0].entries.map((e) => e.year)).toEqual([2014, null]);
  });

  // A leftovers bin is not a subject, so it never leads however big it gets.
  it('keeps the ungrouped bin last even when it is the biggest', () => {
    const groups = buildLineage(
      [ref('https://example.test/a', 'A. 2001.'), ref('https://example.test/b', 'B. 2002.'),
       ref('https://example.test/c', 'C. 2003.')],
      expansion([paper({ topics: ['neuroscience'] })]),
      new Set(),
    );

    expect(groups[groups.length - 1].topic).toBe(UNGROUPED);
    expect(groups[0].topic).toBe('neuroscience');
  });

  // The bibliography is the spine: an entry no index knew about must still be
  // listed, or the reader silently loses references the paper actually cites.
  it('keeps a reference the index never returned', () => {
    const groups = buildLineage(
      [ref('https://example.test/obscure', 'Obscure, A. A book chapter. 1998.', 1998)],
      expansion([]),
      new Set(),
    );

    expect(lineageStats(groups).total).toBe(1);
    expect(groups[0].entries[0].fromDocumentOnly).toBe(true);
  });

  it('keeps a reference the bibliography parser missed', () => {
    const groups = buildLineage([], expansion([paper()]), new Set());

    expect(lineageStats(groups).total).toBe(1);
  });

  it('marks an entry already in the library', () => {
    const groups = buildLineage(
      [ref('https://arxiv.org/abs/2006.11239')],
      expansion([paper()]),
      new Set(['arxiv:2006.11239']),
    );

    expect(groups[0].entries[0].ownedKey).toBe('arxiv:2006.11239');
  });

  // The whole feature has to survive a source that returned no subjects at all
  // — which is every entry when only the local or alphaXiv tier answered.
  it('lists everything under one heading when nothing has a topic', () => {
    const groups = buildLineage(
      [],
      expansion([
        paper({ s2Id: 'a', url: 'https://arxiv.org/abs/1111.11111', topics: [] }),
        paper({ s2Id: 'b', url: 'https://arxiv.org/abs/2222.22222', topics: [] }),
      ]),
      new Set(),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].topic).toBe(UNGROUPED);
    expect(groups[0].entries).toHaveLength(2);
  });

  it('works with no expansion at all — the bibliography alone', () => {
    const groups = buildLineage([ref(null, 'Knuth. TAOCP. 1968.', 1968)], null, new Set());

    expect(lineageStats(groups)).toMatchObject({ total: 1, owned: 0, untopiced: 1 });
  });

  // "Papers that use this one" is a different question and a different section.
  it('ignores the citing half of an expansion', () => {
    const groups = buildLineage(
      [],
      expansion([paper({ relation: 'citation', s2Id: 'citing' })]),
      new Set(),
    );

    expect(lineageStats(groups).total).toBe(0);
  });
});

describe('lineageStats', () => {
  it('counts the total, how many are yours, and how many lack a topic', () => {
    const groups = buildLineage(
      [ref('https://example.test/x', 'No topic here. 2001.', 2001)],
      expansion([paper()]),
      new Set(['arxiv:2006.11239']),
    );

    expect(lineageStats(groups)).toEqual({ total: 2, owned: 1, untopiced: 1 });
  });
});

describe('yearHomes', () => {
  const x = (homes: Map<string, { x: number; y: number }>, id: string) => homes.get(id)!.x;

  it('puts an older work to the left of a newer one', () => {
    const homes = yearHomes([
      { id: 'new', year: 2020 },
      { id: 'old', year: 2015 },
    ]);

    expect(x(homes, 'old')).toBeLessThan(x(homes, 'new'));
  });

  it('spaces columns by how many years actually separate them', () => {
    const homes = yearHomes([
      { id: 'a', year: 2010 },
      { id: 'b', year: 2011 },
      { id: 'c', year: 2020 },
    ]);

    // A decade of silence should look like a decade, not like one step.
    expect(x(homes, 'c') - x(homes, 'b')).toBeGreaterThan(x(homes, 'b') - x(homes, 'a'));
  });

  it('stacks works from the same year in one column', () => {
    const homes = yearHomes([
      { id: 'a', year: 2020 },
      { id: 'b', year: 2020 },
    ]);

    expect(x(homes, 'a')).toBe(x(homes, 'b'));
    expect(homes.get('a')!.y).not.toBe(homes.get('b')!.y);
  });

  // Guessing a year would put a work somewhere specific and wrong. A column
  // meaning "we do not know" is honest in a way a guess is not.
  it('parks undated works in a gutter left of everything dated', () => {
    const homes = yearHomes([
      { id: 'dated', year: 2015 },
      { id: 'unknown', year: null },
    ]);

    expect(x(homes, 'unknown')).toBeLessThan(x(homes, 'dated'));
  });

  it('centres a column on the axis rather than growing downward from it', () => {
    const homes = yearHomes([
      { id: 'a', year: 2020 },
      { id: 'b', year: 2020 },
      { id: 'c', year: 2020 },
    ]);
    const ys = ['a', 'b', 'c'].map((id) => homes.get(id)!.y);

    expect(ys.reduce((n, y) => n + y, 0)).toBeCloseTo(0, 6);
  });

  it('survives a lineage where nothing has a year', () => {
    const homes = yearHomes([
      { id: 'a', year: null },
      { id: 'b', year: null },
    ]);

    expect(homes.size).toBe(2);
    expect(x(homes, 'a')).toBe(x(homes, 'b'));
  });

  it('returns nothing for an empty lineage', () => {
    expect([...yearHomes([])]).toEqual([]);
  });
});
