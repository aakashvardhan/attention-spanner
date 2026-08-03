import { describe, expect, it } from 'vitest';
import { mostRecentUnfinished, resumeContextFromProgress } from './attention';
import type { ReadingProgress, VideoProgress } from './types';

const base = {
  title: 'A document',
  source: '',
  maxPercent: 30,
  activeSeconds: 120,
  firstOpenedAt: 1,
  updatedAt: 10,
  completedAt: null,
  nudge: { count: 0, lastAt: 0, dismissed: false },
};

describe('attention resume context', () => {
  it('preserves an article scroll position', () => {
    const article: ReadingProgress = {
      ...base,
      kind: 'article',
      url: 'https://example.com/article',
      feedItemId: null,
      scrollY: 1840,
      pageHeight: 5000,
    };
    expect(resumeContextFromProgress(article)).toMatchObject({
      kind: 'article',
      url: article.url,
      scrollY: 1840,
      breadcrumb: '',
    });
  });

  it('preserves a video timestamp', () => {
    const video: VideoProgress = {
      ...base,
      kind: 'video',
      url: 'https://youtube.com/watch?v=abc',
      videoId: 'abc',
      durationSeconds: 600,
      positionSeconds: 143,
    };
    expect(resumeContextFromProgress(video)).toMatchObject({
      kind: 'video',
      positionSeconds: 143,
      breadcrumb: '',
    });
  });

  it('selects the most recently updated unfinished item only', () => {
    const older: ReadingProgress = {
      ...base,
      url: 'https://example.com/old',
      feedItemId: null,
      scrollY: 100,
      pageHeight: 1000,
    };
    const newer: ReadingProgress = { ...older, url: 'https://example.com/new', updatedAt: 20 };
    const done: ReadingProgress = {
      ...newer,
      url: 'https://example.com/done',
      updatedAt: 30,
      completedAt: 30,
    };
    expect(mostRecentUnfinished({ older, newer, done }))?.toBe(newer);
  });
});
