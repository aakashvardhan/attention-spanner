import type { FeedItem, Paper, ReadingProgress } from '../src/shared/types';

const HOUR = 60 * 60_000;

export function article(url: string, title: string, overrides: Partial<ReadingProgress> = {}): ReadingProgress {
  const now = Date.now();
  return {
    kind: 'article',
    url,
    title,
    source: 'E2E Source',
    feedItemId: null,
    maxPercent: 40,
    scrollY: 1200,
    pageHeight: 6000,
    activeSeconds: 300,
    firstOpenedAt: now - 24 * HOUR,
    updatedAt: now - HOUR,
    completedAt: null,
    nudge: { count: 0, lastAt: 0, dismissed: false },
    ...overrides,
  };
}

export function feedItem(id: string, title: string, overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id,
    title,
    link: `http://news.e2e.test/${id}`,
    normalizedLink: `news.e2e.test/${id}`,
    pubDate: new Date(Date.now() - HOUR).toISOString(),
    snippet: '',
    source: 'E2E Feed',
    ...overrides,
  };
}

export function paper(id: string, title: string, overrides: Partial<Paper> = {}): Paper {
  const now = Date.now();
  return {
    id,
    deckId: 'e2e-deck',
    title,
    authors: 'A. Author',
    venue: 'E2E',
    year: 2026,
    citations: null,
    url: `https://arxiv.org/abs/2601.${id.padStart(5, '0')}`,
    abstract: `Abstract of ${title}.`,
    relevance: '',
    status: 'reading',
    progressPercent: 30,
    leftOff: '',
    addedAt: now - 48 * HOUR,
    updatedAt: now - HOUR,
    lastReadAt: now - HOUR,
    ...overrides,
  };
}

export const deck = { id: 'e2e-deck', name: 'E2E deck', kind: 'papers', createdAt: Date.now() };
