import { describe, expect, it } from 'vitest';
import type { ResumableItem } from '../../shared/attention';
import type { Paper, ReadingProgress, VideoProgress } from '../../shared/types';
import { kickerFor, leadStatus } from './ContinueRow';

const base = { maxPercent: 42, activeSeconds: 0, firstOpenedAt: 0, completedAt: null, nudge: { count: 0, lastAt: 0, dismissed: false } };
const article = (updatedAt: number): ResumableItem => ({
  key: 'a', title: 'A', updatedAt, paper: null,
  progress: { ...base, url: 'https://x.org/a', title: 'A', source: 'Distill', updatedAt, kind: 'article', feedItemId: null, scrollY: 0, pageHeight: 1 } as ReadingProgress,
});
const video: ResumableItem = {
  key: 'v', title: 'V', updatedAt: 0, paper: null,
  progress: { ...base, url: 'https://youtube.com/watch?v=1', title: 'V', source: 'Ch', updatedAt: 0, kind: 'video', videoId: '1', durationSeconds: 600, positionSeconds: 125 } as VideoProgress,
};
const paper = (extra: Partial<Paper>): ResumableItem => ({
  key: 'p', title: 'P', updatedAt: 0, progress: null,
  paper: { progressPercent: 30, leftOff: '', ...extra } as Paper,
});

describe('leadStatus', () => {
  it('gives a paper opened in the reader its page, and the left-off note when there is one', () => {
    expect(leadStatus(paper({ pdf: { url: 'u', page: 4, pageCount: 15, offset: 0 } }))).toBe('Page 4 of 15');
    expect(leadStatus(paper({ pdf: { url: 'u', page: 4, pageCount: 15, offset: 0 }, leftOff: 'Section 4.2' }))).toBe('Page 4 of 15 · Section 4.2');
  });

  it('falls back to percent for a paper never opened in the reader', () => {
    expect(leadStatus(paper({}))).toBe('30% read');
  });

  it('gives an article its percent and when it was opened', () => {
    expect(leadStatus(article(Date.now() - 2 * 3_600_000))).toBe('42% read · opened 2h ago');
  });

  it('gives a video its position and length', () => {
    expect(leadStatus(video)).toBe('2:05 of 10:00');
  });
});

describe('kickerFor', () => {
  it('names what kind of thing is waiting', () => {
    expect(kickerFor(paper({}))).toBe('Continue reading · paper');
    expect(kickerFor(article(0))).toBe('Continue reading · article');
    expect(kickerFor(video)).toBe('Continue watching · video');
  });
});
