import { describe, expect, it } from 'vitest';
import type { ReadingProgress, VideoProgress } from './types';
import {
  getYouTubeVideoId,
  isWatchingNow,
  isYouTubeWatchUrl,
  keyMatchesUrl,
  livePositionSeconds,
  videoKey,
} from './youtube';

describe('getYouTubeVideoId', () => {
  it('extracts from standard watch URLs', () => {
    expect(getYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(getYouTubeVideoId('https://youtube.com/watch?v=dQw4w9WgXcQ&t=120s')).toBe(
      'dQw4w9WgXcQ',
    );
    expect(
      getYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx&index=3'),
    ).toBe('dQw4w9WgXcQ');
  });

  it('extracts from youtu.be short links', () => {
    expect(getYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(getYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=42')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from mobile and music hosts', () => {
    expect(getYouTubeVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(getYouTubeVideoId('https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    );
  });

  it('extracts from /live/ URLs', () => {
    expect(getYouTubeVideoId('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('returns null for Shorts', () => {
    expect(getYouTubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBeNull();
  });

  it('returns null for non-video YouTube pages', () => {
    expect(getYouTubeVideoId('https://www.youtube.com/')).toBeNull();
    expect(getYouTubeVideoId('https://www.youtube.com/feed/subscriptions')).toBeNull();
    expect(getYouTubeVideoId('https://www.youtube.com/@somechannel')).toBeNull();
    expect(getYouTubeVideoId('https://www.youtube.com/watch')).toBeNull();
  });

  it('returns null for non-YouTube URLs and garbage', () => {
    expect(getYouTubeVideoId('https://vimeo.com/12345678')).toBeNull();
    expect(getYouTubeVideoId('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(getYouTubeVideoId('not a url')).toBeNull();
    expect(getYouTubeVideoId('https://www.youtube.com/watch?v=ab')).toBeNull(); // too short
  });
});

describe('isYouTubeWatchUrl / videoKey', () => {
  it('agree with getYouTubeVideoId', () => {
    expect(isYouTubeWatchUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
    expect(isYouTubeWatchUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(false);
    expect(videoKey('dQw4w9WgXcQ')).toBe('yt:dQw4w9WgXcQ');
  });
});

const NOW = 1_700_000_000_000;

function videoProgress(over: Partial<VideoProgress> = {}): VideoProgress {
  return {
    kind: 'video',
    videoId: 'dQw4w9WgXcQ',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'A talk',
    source: 'A channel',
    maxPercent: 40,
    durationSeconds: 600,
    positionSeconds: 240,
    activeSeconds: 240,
    firstOpenedAt: NOW - 600_000,
    updatedAt: NOW,
    completedAt: null,
    playing: true,
    nudge: { count: 0, lastAt: 0, dismissed: false },
    ...over,
  };
}

describe('isWatchingNow', () => {
  it('is true while heartbeats keep arriving', () => {
    expect(isWatchingNow(videoProgress(), NOW)).toBe(true);
    expect(isWatchingNow(videoProgress({ updatedAt: NOW - 6000 }), NOW)).toBe(true);
  });

  it('is false once the last report says stopped', () => {
    expect(isWatchingNow(videoProgress({ playing: false }), NOW)).toBe(false);
  });

  it('expires when the heartbeat dies without a stop flush', () => {
    expect(isWatchingNow(videoProgress({ updatedAt: NOW - 20_000 }), NOW)).toBe(false);
  });

  it('is false for entries written before the playing flag existed', () => {
    expect(isWatchingNow(videoProgress({ playing: undefined }), NOW)).toBe(false);
  });

  it('is false for articles, which have no playhead', () => {
    const article: ReadingProgress = {
      kind: 'article',
      url: 'https://blog.com/post',
      title: 'Post',
      source: 'Blog',
      maxPercent: 30,
      activeSeconds: 60,
      feedItemId: null,
      scrollY: 100,
      pageHeight: 4000,
      firstOpenedAt: NOW - 60_000,
      updatedAt: NOW,
      completedAt: null,
      nudge: { count: 0, lastAt: 0, dismissed: false },
    };
    expect(isWatchingNow(article, NOW)).toBe(false);
  });
});

describe('livePositionSeconds', () => {
  it('extrapolates from the last heartbeat while playing', () => {
    expect(livePositionSeconds(videoProgress({ updatedAt: NOW - 3000 }), NOW)).toBe(243);
  });

  it('holds the stored position when paused', () => {
    expect(livePositionSeconds(videoProgress({ playing: false }), NOW)).toBe(240);
  });

  it('holds the stored position once the heartbeat is stale', () => {
    const stale = videoProgress({ updatedAt: NOW - 60_000 });
    expect(livePositionSeconds(stale, NOW)).toBe(240);
  });

  it('never runs past the end of the video', () => {
    const nearEnd = videoProgress({ positionSeconds: 598, updatedAt: NOW - 14_000 });
    expect(livePositionSeconds(nearEnd, NOW)).toBe(600);
  });
});

describe('keyMatchesUrl', () => {
  it('matches video keys by videoId across URL variants', () => {
    expect(keyMatchesUrl('yt:dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?t=99')).toBe(true);
    expect(
      keyMatchesUrl('yt:dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1'),
    ).toBe(true);
    expect(keyMatchesUrl('yt:dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=otherVid99')).toBe(
      false,
    );
  });

  it('matches article keys by normalized URL', () => {
    expect(keyMatchesUrl('blog.com/post', 'https://www.blog.com/post?utm_source=x')).toBe(true);
    expect(keyMatchesUrl('blog.com/post', 'https://blog.com/other')).toBe(false);
  });
});
