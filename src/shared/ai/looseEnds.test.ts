import { describe, expect, it } from 'vitest';
import type { AnyProgress, Paper, Task } from '../types';
import {
  findLooseEnds,
  formatLooseEnds,
  MAX_LOOSE_ENDS,
  STALE_DAYS,
  type LooseEndsData,
} from './looseEnds';

const NOW = new Date(2026, 6, 26, 12, 0, 0).getTime();
const DAY = 86_400_000;
const ago = (days: number) => NOW - days * DAY;

function paper(overrides: Partial<Paper> = {}): Paper {
  return {
    id: 'p1',
    deckId: 'd1',
    title: 'Attention Is All You Need',
    authors: '',
    venue: '',
    year: null,
    citations: null,
    url: 'https://example.com/paper',
    abstract: '',
    relevance: '',
    status: 'reading',
    progressPercent: 40,
    leftOff: '',
    createdAt: 0,
    updatedAt: ago(30),
    ...overrides,
  } as Paper;
}

function progress(overrides: Partial<AnyProgress> = {}): AnyProgress {
  return {
    url: 'https://example.com/article',
    title: 'A Long Article',
    maxPercent: 45,
    activeSeconds: 600,
    completedAt: null,
    updatedAt: ago(20),
    ...overrides,
  } as AnyProgress;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    text: 'Email the landlord',
    createdAt: ago(40),
    completedAt: null,
    snoozedUntil: null,
    source: 'newtab',
    ...overrides,
  };
}

function data(overrides: Partial<LooseEndsData> = {}): LooseEndsData {
  return { papers: [], readingProgress: {}, tasks: [], ...overrides };
}

describe('findLooseEnds', () => {
  it('finds nothing in empty data', () => {
    expect(findLooseEnds(data(), NOW)).toEqual([]);
  });

  it('flags a paper stuck mid-read past the threshold', () => {
    const stale = findLooseEnds(data({ papers: [paper()] }), NOW);
    expect(stale).toHaveLength(1);
    expect(stale[0].kind).toBe('paper');
    expect(stale[0].label).toContain('stopped at 40%');
    expect(stale[0].staleDays).toBe(30);
    expect(stale[0].url).toBe('https://example.com/paper');
  });

  it('leaves a recently-touched paper alone', () => {
    const fresh = paper({ updatedAt: ago(STALE_DAYS.paper - 1) });
    expect(findLooseEnds(data({ papers: [fresh] }), NOW)).toEqual([]);
  });

  it('prefers lastReadAt over updatedAt for papers', () => {
    const recentlyRead = paper({ updatedAt: ago(90), lastReadAt: ago(2) });
    expect(findLooseEnds(data({ papers: [recentlyRead] }), NOW)).toEqual([]);
  });

  it('ignores papers that are not being read', () => {
    for (const status of ['to-read', 'read'] as const) {
      expect(findLooseEnds(data({ papers: [paper({ status })] }), NOW)).toEqual([]);
    }
  });

  it('includes the leftOff note when there is one', () => {
    const withNote = paper({ leftOff: 'Section 4.2 — ablations' });
    expect(findLooseEnds(data({ papers: [withNote] }), NOW)[0].label).toContain(
      'Section 4.2 — ablations',
    );
  });

  it('flags abandoned reading but not finished or barely-started items', () => {
    const found = findLooseEnds(
      data({
        readingProgress: {
          a: progress(),
          done: progress({ url: 'b', completedAt: 5 }),
          bounced: progress({ url: 'c', maxPercent: 1, activeSeconds: 2 }),
        },
      }),
      NOW,
    );
    expect(found.map((f) => f.kind)).toEqual(['reading']);
    expect(found[0].label).toContain('45% in');
  });

  it('flags long-open tasks and skips completed ones', () => {
    const found = findLooseEnds(
      data({ tasks: [task(), task({ id: 't2', completedAt: NOW, createdAt: ago(99) })] }),
      NOW,
    );
    expect(found).toHaveLength(1);
    expect(found[0].label).toContain('on the list 40 days');
    expect(found[0].url).toBe('');
  });

  it('sorts stalest first and caps the list', () => {
    const tasks = Array.from({ length: MAX_LOOSE_ENDS + 4 }, (_, i) =>
      task({ id: `t${i}`, text: `Task ${i}`, createdAt: ago(STALE_DAYS.task + i) }),
    );
    const found = findLooseEnds(data({ tasks }), NOW);
    expect(found).toHaveLength(MAX_LOOSE_ENDS);
    expect(found[0].staleDays).toBeGreaterThan(found[1].staleDays);
    expect(found[0].label).toContain(`Task ${MAX_LOOSE_ENDS + 3}`);
  });
});

describe('formatLooseEnds', () => {
  it('says so plainly when nothing is stalled', () => {
    expect(formatLooseEnds([])).toContain('Nothing stalled');
  });

  it('renders one line per item with kind and age', () => {
    const out = formatLooseEnds(findLooseEnds(data({ tasks: [task()] }), NOW));
    expect(out).toBe('- [task] “Email the landlord” — on the list 40 days (40d)');
  });
});
