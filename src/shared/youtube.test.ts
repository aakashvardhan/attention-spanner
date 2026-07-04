import { describe, expect, it } from 'vitest';
import { getYouTubeVideoId, isYouTubeWatchUrl, keyMatchesUrl, videoKey } from './youtube';

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
