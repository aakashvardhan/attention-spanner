import { normalizeUrl } from './urlNormalize';

/**
 * YouTube URL identity helpers. Videos are keyed `yt:<videoId>` in the
 * progress map — videoId-based identity survives &t=/&list=/youtu.be
 * variants that URL normalization would not collapse.
 */

export const VIDEO_KEY_PREFIX = 'yt:';

const ID_SHAPE = /^[A-Za-z0-9_-]{6,}$/;

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

/** Extracts the video id from any YouTube watch-style URL; null for Shorts and non-video pages */
export function getYouTubeVideoId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();

  const validate = (id: string | null | undefined) =>
    id && ID_SHAPE.test(id) ? id : null;

  if (host === 'youtu.be') {
    return validate(u.pathname.split('/')[1]);
  }
  if (!YT_HOSTS.has(host)) return null;
  if (u.pathname.startsWith('/shorts/')) return null;
  if (u.pathname === '/watch') {
    return validate(u.searchParams.get('v'));
  }
  if (u.pathname.startsWith('/live/')) {
    return validate(u.pathname.split('/')[2]);
  }
  return null;
}

export function isYouTubeWatchUrl(url: string): boolean {
  return getYouTubeVideoId(url) !== null;
}

export function videoKey(videoId: string): string {
  return VIDEO_KEY_PREFIX + videoId;
}

/** Does this tab URL correspond to this progress key (article or video)? */
export function keyMatchesUrl(key: string, url: string): boolean {
  if (key.startsWith(VIDEO_KEY_PREFIX)) {
    return getYouTubeVideoId(url) === key.slice(VIDEO_KEY_PREFIX.length);
  }
  return normalizeUrl(url) === key;
}
