import { describe, expect, it } from 'vitest';
import { resumableItems, resumeContextFromProgress } from './attention';
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
    });
  });
});

describe('resumableItems', () => {
  it('lists every unfinished article, not just the newest six', () => {
    const progress: Record<string, ReadingProgress> = {};
    for (let i = 0; i < 9; i++) {
      const url = `https://example.com/${i}`;
      progress[url] = {
        ...base,
        kind: 'article',
        url,
        updatedAt: i,
        feedItemId: null,
        scrollY: 0,
        pageHeight: 1000,
      };
    }
    const items = resumableItems(progress, []);
    expect(items).toHaveLength(9);
    expect(items[0].progress?.url).toBe('https://example.com/8');
  });
});
