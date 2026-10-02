import { describe, expect, it } from 'vitest';
import { belongsInContinue, isInProgress, progressKind } from './progress';
import type { AnyProgress, ReadingProgress, VideoProgress } from './types';

function article(over: Partial<ReadingProgress> = {}): ReadingProgress {
  return {
    kind: 'article',
    url: 'https://example.com/a',
    feedItemId: null,
    title: 'A piece',
    source: '',
    maxPercent: 0,
    scrollY: 0,
    pageHeight: 2000,
    activeSeconds: 0,
    firstOpenedAt: 0,
    updatedAt: 0,
    completedAt: null,
    nudge: { count: 0, lastAt: 0, dismissed: false },
    ...over,
  };
}

function video(over: Partial<VideoProgress> = {}): VideoProgress {
  return {
    ...article(),
    kind: 'video',
    videoId: 'abc',
    durationSeconds: 600,
    positionSeconds: 0,
    ...over,
  } as VideoProgress;
}

describe('isInProgress', () => {
  it('lists something you have scrolled into', () => {
    expect(isInProgress(article({ maxPercent: 6 }))).toBe(true);
  });

  it('ignores a page you bounced straight off', () => {
    expect(isInProgress(article({ maxPercent: 2, activeSeconds: 4 }))).toBe(false);
  });

  it('lists a link you are reading but have not scrolled yet', () => {
    // A link opened from the Links panel sits at 0% until the first scroll;
    // dwell time is what makes it show up.
    expect(isInProgress(article({ maxPercent: 0, activeSeconds: 45 }))).toBe(true);
  });

  it('drops anything finished', () => {
    expect(isInProgress(article({ maxPercent: 95, completedAt: 1 }))).toBe(false);
    expect(isInProgress(article({ activeSeconds: 900, completedAt: 1 }))).toBe(false);
  });

  it('treats videos the same way', () => {
    expect(isInProgress(video({ maxPercent: 20 }))).toBe(true);
    expect(isInProgress(video({ maxPercent: 1, activeSeconds: 2 }))).toBe(false);
  });
});

describe('belongsInContinue', () => {
  const NOW = 1_700_000_000_000;

  it('keeps a video that is still playing past the completion mark', () => {
    // A 2.5-hour episode is "complete" at 90% with 15 minutes left to run.
    const playing = video({
      durationSeconds: 9069,
      maxPercent: 97,
      completedAt: NOW - 600_000,
      playing: true,
      updatedAt: NOW - 2000,
    });
    expect(isInProgress(playing)).toBe(false);
    expect(belongsInContinue(playing, NOW)).toBe(true);
  });

  it('drops it once the heartbeat stops', () => {
    const paused = video({ maxPercent: 97, completedAt: NOW - 600_000, playing: false });
    const dead = video({
      maxPercent: 97,
      completedAt: NOW - 600_000,
      playing: true,
      updatedAt: NOW - 60_000,
    });
    expect(belongsInContinue(paused, NOW)).toBe(false);
    expect(belongsInContinue(dead, NOW)).toBe(false);
  });

  it('still lists the unfinished things', () => {
    expect(belongsInContinue(article({ maxPercent: 6 }), NOW)).toBe(true);
    expect(belongsInContinue(article({ maxPercent: 2, activeSeconds: 4 }), NOW)).toBe(false);
  });
});

describe('progressKind', () => {
  it('splits videos from articles', () => {
    expect(progressKind(video())).toBe('video');
    expect(progressKind(article())).toBe('article');
  });

  it('counts pre-Phase-6 entries with no kind field as articles', () => {
    const legacy = { ...article() } as Partial<ReadingProgress>;
    delete legacy.kind;
    expect(progressKind(legacy as AnyProgress)).toBe('article');
  });
});
