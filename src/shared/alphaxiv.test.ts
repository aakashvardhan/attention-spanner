import { describe, expect, it } from 'vitest';
import {
  alphaxivPaperRef,
  arxivIdFrom,
  buildDiscoverArgs,
  DISCOVER_DIFFICULTY,
  formatDiscoveredPapers,
  formatPageExcerpts,
  pagesToContext,
  parseDiscoveredPapers,
  parsePagesXml,
  summarizeLibrary,
} from './alphaxiv';

describe('arxivIdFrom', () => {
  it('strips abs/pdf/version wrappers down to the bare id', () => {
    for (const input of [
      'https://arxiv.org/abs/2006.11239',
      'https://arxiv.org/pdf/2006.11239.pdf',
      'https://arxiv.org/abs/2006.11239v3',
      '2006.11239',
    ]) {
      expect(arxivIdFrom(input)).toBe('2006.11239');
    }
  });

  it('keeps legacy ids and rejects non-arXiv references', () => {
    expect(arxivIdFrom('hep-th/9901001')).toBe('hep-th/9901001');
    expect(arxivIdFrom('https://doi.org/10.1145/3292500.3330701')).toBeNull();
    expect(arxivIdFrom('https://example.com/paper.pdf')).toBeNull();
    expect(arxivIdFrom('')).toBeNull();
  });
});

describe('alphaxivPaperRef', () => {
  it('prefers the bare arXiv id', () => {
    expect(alphaxivPaperRef('https://arxiv.org/pdf/1706.03762v5')).toBe('1706.03762');
  });

  it('passes other http(s) papers through for the server to resolve', () => {
    expect(alphaxivPaperRef('https://example.com/path/paper.pdf')).toBe(
      'https://example.com/path/paper.pdf',
    );
    expect(alphaxivPaperRef('  https://doi.org/10.1145/3292500  ')).toBe(
      'https://doi.org/10.1145/3292500',
    );
  });

  it('returns null for what alphaXiv could never fetch', () => {
    expect(alphaxivPaperRef('file:///Users/me/paper.pdf')).toBeNull();
    expect(alphaxivPaperRef('blob:chrome-extension://abc/123')).toBeNull();
    expect(alphaxivPaperRef('')).toBeNull();
  });
});

describe('parsePagesXml', () => {
  const xml =
    '<paper id="2307.12307">\n' +
    '  <page num="4">We train on C4 and\n  The Pile.</page>\n' +
    '  <page num="11">Ablations in Table 3 &amp; Figure 2 show &lt;1% drift.</page>\n' +
    '</paper>';

  it('pulls the resolved paper id and every page', () => {
    const parsed = parsePagesXml(xml);
    expect(parsed.paperId).toBe('2307.12307');
    expect(parsed.pages.map((p) => p.num)).toEqual([4, 11]);
  });

  it('collapses whitespace and decodes entities in page text', () => {
    const parsed = parsePagesXml(xml);
    expect(parsed.pages[0].text).toBe('We train on C4 and The Pile.');
    expect(parsed.pages[1].text).toBe('Ablations in Table 3 & Figure 2 show <1% drift.');
  });

  it('drops empty pages and reports nothing for unrecognized output', () => {
    expect(parsePagesXml('<paper id="x"><page num="2">   </page></paper>').pages).toEqual([]);
    const plain = parsePagesXml('Sorry, no relevant pages were found.');
    expect(plain.pages).toEqual([]);
    expect(plain.paperId).toBeNull();
  });

  it('labels pages for the answering model', () => {
    expect(pagesToContext(parsePagesXml(xml))).toBe(
      '[page 4] We train on C4 and The Pile.\n\n[page 11] Ablations in Table 3 & Figure 2 show <1% drift.',
    );
  });
});

describe('formatPageExcerpts', () => {
  const answer = {
    paperId: '1706.03762',
    pages: [
      { num: 3, text: 'a'.repeat(50) },
      { num: 5, text: 'b' },
      { num: 8, text: 'c' },
      { num: 9, text: 'd' },
    ],
  };

  it('quotes at most maxPages, truncating long ones', () => {
    const out = formatPageExcerpts(answer, 2, 10);
    expect(out).toBe(`Page 3: ${'a'.repeat(10)}…\n\nPage 5: b`);
  });

  it('leaves short pages whole', () => {
    expect(formatPageExcerpts({ paperId: null, pages: [{ num: 1, text: 'short' }] })).toBe(
      'Page 1: short',
    );
  });
});

describe('parseDiscoveredPapers', () => {
  // Trimmed from a real search for "vision language action models"
  const raw =
    '1. [ID=2406.09246] **OpenVLA: An Open-Source Vision-Language-Action Model** ' +
    '(https://www.alphaxiv.org/abs/2406.09246). Published 2024-09-04 by Google DeepMind, ' +
    'UC Berkeley, Stanford University · 458 votes · 32655 views: Large policies pretrained ' +
    'on a combination of Internet-scale vision-language data and diverse robot ' +
    'demonstrations have the potential to change how we teach robots new skills...\n' +
    '2. [ID=2510.07077] **Vision-Language-Action Models for Robotics: A Review** ' +
    '(https://www.alphaxiv.org/abs/2510.07077). Published 2025-10-08 · 73 votes · 1496 ' +
    'views: Amid growing efforts to leverage advances in large language models...\n' +
    '3. [ID=hep-th/9901001] **A legacy-id paper** ' +
    '(https://www.alphaxiv.org/abs/hep-th/9901001). Published 1999-01-01 · 2 votes · 9 views:';

  it('pulls every field out of a full entry', () => {
    expect(parseDiscoveredPapers(raw)[0]).toEqual({
      id: '2406.09246',
      title: 'OpenVLA: An Open-Source Vision-Language-Action Model',
      url: 'https://www.alphaxiv.org/abs/2406.09246',
      published: '2024-09-04',
      authors: 'Google DeepMind, UC Berkeley, Stanford University',
      votes: 458,
      abstract:
        'Large policies pretrained on a combination of Internet-scale vision-language data ' +
        'and diverse robot demonstrations have the potential to change how we teach robots ' +
        'new skills...',
    });
  });

  it('keeps entries that omit the byline or the abstract', () => {
    const [, review, legacy] = parseDiscoveredPapers(raw);
    expect(review.authors).toBe('');
    expect(review.votes).toBe(73);
    expect(review.abstract).toMatch(/^Amid growing efforts/);
    expect(legacy.id).toBe('hep-th/9901001');
    expect(legacy.abstract).toBe('');
  });

  it('truncates long abstracts', () => {
    const long = `1. [ID=1] **T** (https://x.test/1). Published 2020-01-01 · 1 votes · 2 views: ${'a'.repeat(400)}`;
    const { abstract } = parseDiscoveredPapers(long)[0];
    expect(abstract).toHaveLength(221);
    expect(abstract.endsWith('…')).toBe(true);
  });

  it('falls back to the alphaXiv page when an entry carries no link', () => {
    expect(parseDiscoveredPapers('1. [ID=2406.09246] **OpenVLA**.')[0].url).toBe(
      'https://www.alphaxiv.org/abs/2406.09246',
    );
  });

  it('reads a title that was not bolded', () => {
    const plain = '1. [ID=1234.5678] Some Untitled Paper (https://x.test/1). Published 2020-01-01';
    expect(parseDiscoveredPapers(plain)[0].title).toBe('Some Untitled Paper');
  });

  it('reports nothing for output it does not recognize', () => {
    expect(parseDiscoveredPapers('No papers matched that search.')).toEqual([]);
    expect(parseDiscoveredPapers('')).toEqual([]);
  });
});

describe('formatDiscoveredPapers', () => {
  const papers = Array.from({ length: 7 }, (_, i) => ({
    id: `100${i}.0000`,
    title: `Paper ${i}`,
    url: '',
    published: '',
    authors: '',
    votes: null,
    abstract: '',
  }));

  it('names the first few and counts the rest', () => {
    expect(formatDiscoveredPapers(papers, ' diffusion ')).toBe(
      '7 papers on “diffusion”:\n' +
        '1. Paper 0 (1000.0000)\n2. Paper 1 (1001.0000)\n3. Paper 2 (1002.0000)\n' +
        '4. Paper 3 (1003.0000)\n5. Paper 4 (1004.0000)\n…and 2 more.',
    );
  });

  it('drops the tail and the plural for a single hit', () => {
    expect(formatDiscoveredPapers(papers.slice(0, 1), 'rag')).toBe(
      '1 paper on “rag”:\n1. Paper 0 (1000.0000)',
    );
  });
});

describe('buildDiscoverArgs', () => {
  it('drops filler words and keeps at most four keywords', () => {
    const args = buildDiscoverArgs('recent papers on speculative decoding for large language models');
    expect(args.keywords).toEqual(['speculative', 'decoding', 'large', 'language']);
    expect(args.difficulty).toBe(DISCOVER_DIFFICULTY);
  });

  it('sends the topic verbatim as the semantic question', () => {
    expect(buildDiscoverArgs('  diffusion model sampling  ').question).toBe(
      'diffusion model sampling',
    );
  });

  it('keeps technical tokens that punctuation would otherwise split', () => {
    expect(buildDiscoverArgs('C++ and GPT-4 benchmarks').keywords).toEqual([
      'c++',
      'gpt-4',
      'benchmarks',
    ]);
  });

  it('only asks for recency when the caller says so', () => {
    expect(buildDiscoverArgs('rag').prioritize).toBeUndefined();
    expect(buildDiscoverArgs('rag', true).prioritize).toBe('recency');
  });

  it('falls back to the raw words when the topic is all filler', () => {
    expect(buildDiscoverArgs('find me some recent papers').keywords).toEqual([
      'find',
      'me',
      'some',
      'recent',
    ]);
  });
});

describe('summarizeLibrary', () => {
  const library = (folders: unknown[]) => JSON.stringify({ folders });

  it('names the folders holding papers, biggest first', () => {
    expect(
      summarizeLibrary(
        library([
          { folder_id: 'a', name: 'Want to read', paper_count: 7 },
          { folder_id: 'b', name: 'Reading', paper_count: 0 },
          { folder_id: 'c', name: 'Diffusion', paper_count: 12 },
        ]),
      ),
    ).toBe('Connected — 19 papers across 3 folders: Diffusion (12), Want to read (7).');
  });

  it('counts the folders it does not name', () => {
    const folders = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, i) => ({
      name,
      paper_count: 6 - i,
    }));
    expect(summarizeLibrary(library(folders))).toBe(
      'Connected — 21 papers across 6 folders: a (6), b (5), c (4), d (3), and 2 more folders.',
    );
  });

  it('reports an empty library without listing its default folders', () => {
    expect(summarizeLibrary(library([{ name: 'Want to read', paper_count: 0 }]))).toBe(
      'Connected — 1 folder, no papers saved yet.',
    );
  });

  it('still confirms the connection when the payload is unrecognised', () => {
    expect(summarizeLibrary('')).toBe('Connected to alphaXiv.');
    expect(summarizeLibrary('Your library is empty.')).toBe('Connected to alphaXiv.');
    expect(summarizeLibrary(library([{ folder_id: 'a' }]))).toBe('Connected to alphaXiv.');
  });
});
