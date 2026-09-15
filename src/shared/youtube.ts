import { VIDEO_WATCHING_STALE_MS } from './constants';
import type { AnyProgress, VideoProgress } from './types';
import { normalizeUrl } from './urlNormalize';

/**
 * YouTube identity and watch-state helpers. Videos are keyed `yt:<videoId>` in
 * the progress map — videoId-based identity survives &t=/&list=/youtu.be
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

/**
 * Is this video playing right now? Derived from the tracker's heartbeat: the
 * `playing` flag says what the last report was, and the staleness window
 * expires the badge when the reports stop arriving at all.
 */
export function isWatchingNow(
  progress: AnyProgress,
  now = Date.now(),
): progress is VideoProgress {
  return (
    progress.kind === 'video' &&
    progress.playing === true &&
    now - progress.updatedAt < VIDEO_WATCHING_STALE_MS
  );
}

/**
 * Playhead extrapolated from the last heartbeat, so the readout ticks every
 * second instead of jumping every five. Each report corrects the estimate; a
 * video that is not playing reports its stored position unchanged.
 */
export function livePositionSeconds(progress: VideoProgress, now = Date.now()): number {
  // Read the fields up front: isWatchingNow narrows to VideoProgress, so inside
  // the negative branch TS has already subtracted that from VideoProgress and
  // is left with never.
  const { positionSeconds, durationSeconds, updatedAt } = progress;
  if (!isWatchingNow(progress, now)) return positionSeconds;
  return Math.min(durationSeconds, positionSeconds + (now - updatedAt) / 1000);
}

/**
 * The video playing right now, or null. This is the whole live-state layer:
 * the tracker already writes position, duration, title and channel every five
 * seconds, so a second copy in session storage would only be a cache to
 * invalidate.
 *
 * Recency settles "which one" when several tabs report as playing — the newest
 * heartbeat is the best available proxy for the one in front of you, and it
 * needs no designation protocol. Nothing reads `playing` raw, so a tab that
 * dies without a pagehide flush ages out through isWatchingNow rather than
 * needing a sweeper.
 */
export function currentlyWatching(
  progress: Record<string, AnyProgress>,
  now = Date.now(),
): VideoProgress | null {
  let best: VideoProgress | null = null;
  for (const entry of Object.values(progress)) {
    if (entry.kind !== 'video' || !isWatchingNow(entry, now)) continue;
    if (!best || entry.updatedAt > best.updatedAt) best = entry;
  }
  return best;
}

/**
 * Did the user leave this video and stay on YouTube? That is the rabbit hole —
 * another video, a Short, or the subscriptions feed — and it reads differently
 * from closing the tab, which is ordinary abandonment and keeps the existing
 * nudge copy. Called at nudge fire time against the active tab, so it needs no
 * state of its own and no second alarm.
 */
export function driftedAway(key: string, activeUrl: string | undefined): boolean {
  if (!activeUrl || !key.startsWith(VIDEO_KEY_PREFIX)) return false;
  let host: string;
  try {
    host = new URL(activeUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const onYouTube = host === 'youtu.be' || YT_HOSTS.has(host);
  return onYouTube && !keyMatchesUrl(key, activeUrl);
}

/** Does this tab URL correspond to this progress key (article or video)? */
export function keyMatchesUrl(key: string, url: string): boolean {
  if (key.startsWith(VIDEO_KEY_PREFIX)) {
    return getYouTubeVideoId(url) === key.slice(VIDEO_KEY_PREFIX.length);
  }
  return normalizeUrl(url) === key;
}
