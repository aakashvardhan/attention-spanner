import { describe, expect, it } from 'vitest';
import type { ResumableItem } from '../../shared/attention';
import type { Paper, ReadingProgress, VideoProgress } from '../../shared/types';
import { rowMeta } from './ContinueRow';

const base = { maxPercent: 42, activeSeconds: 0, firstOpenedAt: 0, completedAt: null };
const article: ResumableItem = {
  key: 'a', title: 'A', updatedAt: 0, paper: null,
  progress: { ...base, url: 'https://x.org/a', title: 'A', source: 'Distill', updatedAt: 0, kind: 'article', feedItemId: null, scrollY: 0, pageHeight: 1 } as ReadingProgress,
};
const video: ResumableItem = {
  key: 'v', title: 'V', updatedAt: 0, paper: null,
  progress: { ...base, url: 'https://youtube.com/watch?v=1', title: 'V', source: 'Ch', updatedAt: 0, kind: 'video', videoId: '1', durationSeconds: 600, positionSeconds: 125 } as VideoProgress,
};
const paper = (extra: Partial<Paper>): ResumableItem => ({
  key: 'p', title: 'P', updatedAt: 0, progress: null,
  paper: { progressPercent: 30, leftOff: '', ...extra } as Paper,
});

describe('rowMeta', () => {
  it('gives a paper opened in the reader its page', () => {
    expect(rowMeta(paper({ pdf: { url: 'u', page: 4, pageCount: 15, offset: 0 } }))).toBe('p. 4');
  });

  it('falls back to percent for a paper never opened in the reader', () => {
    expect(rowMeta(paper({}))).toBe('30%');
  });

  it('gives an article its percent', () => {
    expect(rowMeta(article)).toBe('42%');
  });

  it('gives a video its position', () => {
    expect(rowMeta(video)).toBe('2:05');
  });
});
