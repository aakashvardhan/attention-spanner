import { CONTINUE_MIN_PERCENT, CONTINUE_MIN_SECONDS } from './constants';
import type { AnyProgress } from './types';
import { normalizeUrl } from './urlNormalize';
import { getYouTubeVideoId, isWatchingNow, videoKey } from './youtube';

/**
 * Whether an entry belongs in "Continue where I left off".
 *
 * Scroll percent alone was the rule, which never surfaced a link opened from
 * the Links panel: those sit at 0% until the first scroll, and plenty of pages
 * are read without one. Dwell time is the second signal — together they admit
 * anything you actually started and still exclude a tab you bounced off.
 *
 * Shared so the dashboard and the assistant's context agree on what "in
 * progress" means; they used to carry separate copies of the percent rule.
 */
export function isInProgress(progress: AnyProgress): boolean {
  if (progress.completedAt !== null) return false;
  return (
    progress.maxPercent >= CONTINUE_MIN_PERCENT ||
    progress.activeSeconds >= CONTINUE_MIN_SECONDS
  );
}

/**
 * What the Continue panel lists: things left unfinished, plus whatever is
 * playing right now.
 *
 * The second clause exists because completion and playback are not the same
 * event. A video is marked complete at 90%, which on a two-hour episode lands
 * fifteen minutes before the end — and `isInProgress` then dropped the row
 * mid-playback, taking the "Watching now" badge with it. Time-dependent, so
 * callers must pass the same `now` they render with.
 */
export function belongsInContinue(progress: AnyProgress, now = Date.now()): boolean {
  return isInProgress(progress) || isWatchingNow(progress, now);
}

/** Entries written before Phase 6 have no `kind`; they are all articles. */
export function progressKind(progress: AnyProgress): 'article' | 'video' {
  return progress.kind === 'video' ? 'video' : 'article';
}

/** The readingProgress key a URL's progress is stored under. */
export function progressKeyFor(url: string): string {
  const videoId = getYouTubeVideoId(url);
  return videoId ? videoKey(videoId) : normalizeUrl(url);
}
