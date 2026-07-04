import { sendMessage } from '../shared/messages';
import { getYouTubeVideoId } from '../shared/youtube';

/**
 * YouTube watch tracker, injected dynamically into youtube.com tabs.
 * One "session" per video; YouTube is an SPA, so navigation between videos
 * is detected in-page (yt-navigate-finish + URL poll), never by re-injection.
 *
 * Watch time accrues whenever the video is PLAYING — visible or not —
 * because background podcast listening is real consumption. Nudges are
 * driven by `stopped` flushes (pause/ended/leave), not visibility.
 *
 * Bundled standalone (IIFE) by esbuild, same as readingTracker.
 */

declare global {
  interface Window {
    __adhdVideoTrackerLoaded?: boolean;
  }
}

const REPORT_INTERVAL_MS = 5000;
const PLAYER_RETRY_MS = 500;
const PLAYER_RETRY_MAX_MS = 15_000;
const RESUME_RETRY_MS = 500;
const RESUME_MAX_MS = 4000;
const NAV_POLL_MS = 2000;

if (!window.__adhdVideoTrackerLoaded) {
  window.__adhdVideoTrackerLoaded = true;
  initVideoTracker();
}

function initVideoTracker() {
  let currentVideoId: string | null = null;
  let session: { stop: () => void } | null = null;

  const restartSession = () => {
    const videoId = getYouTubeVideoId(location.href);
    if (videoId === currentVideoId) return;
    session?.stop(); // flushes stopped:true for the previous video
    session = null;
    currentVideoId = videoId;
    if (videoId) {
      startSession(videoId).then((s) => {
        // Guard against a navigation racing session startup
        if (currentVideoId === videoId) session = s;
        else s?.stop();
      });
    }
  };

  window.addEventListener('yt-navigate-finish', () => restartSession());
  setInterval(() => restartSession(), NAV_POLL_MS);
  restartSession();
}

function findPlayer(): Promise<HTMLVideoElement | null> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const attempt = () => {
      const video =
        document.querySelector<HTMLVideoElement>('video.html5-main-video') ??
        document.querySelector<HTMLVideoElement>('video');
      if (video) return resolve(video);
      if (Date.now() - startedAt > PLAYER_RETRY_MAX_MS) return resolve(null);
      setTimeout(attempt, PLAYER_RETRY_MS);
    };
    attempt();
  });
}

function awaitMetadata(video: HTMLVideoElement): Promise<void> {
  if (!Number.isNaN(video.duration) && video.duration > 0) return Promise.resolve();
  return new Promise((resolve) => {
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
}

function pageTitle(): string {
  return document.title.replace(/ - YouTube$/, '').trim();
}

function channelName(): string {
  return (
    document.querySelector('ytd-channel-name a')?.textContent?.trim() ??
    document.querySelector('link[itemprop="name"]')?.getAttribute('content') ??
    ''
  );
}

async function startSession(videoId: string): Promise<{ stop: () => void } | null> {
  if (location.pathname.startsWith('/shorts')) return null;

  const video = await findPlayer();
  if (!video) return null;
  await awaitMetadata(video);
  if (!Number.isFinite(video.duration) || video.duration <= 0) return null; // live stream

  let track = false;
  let resume: { positionSeconds: number } | null = null;
  try {
    const res = await sendMessage({
      type: 'VIDEO_TRACKER_READY',
      videoId,
      durationSeconds: video.duration,
      url: location.href,
      title: pageTitle(),
      channel: channelName(),
    });
    track = res?.track ?? false;
    resume = res?.resume ?? null;
  } catch {
    return null; // extension reloaded; orphaned script
  }
  if (!track) return null;

  let watchedSecondsPending = 0;
  let lastSentStopped = false;
  let stopped = false;
  const timers: number[] = [];

  async function report(stoppedFlush: boolean) {
    if (stoppedFlush && lastSentStopped) return;
    lastSentStopped = stoppedFlush;
    const delta = watchedSecondsPending;
    watchedSecondsPending = 0;
    try {
      await sendMessage({
        type: 'VIDEO_PROGRESS',
        videoId,
        positionSeconds: video!.currentTime,
        durationSeconds: video!.duration,
        watchedSecondsDelta: delta,
        stopped: stoppedFlush,
        title: pageTitle(),
        channel: channelName(),
      });
    } catch {
      watchedSecondsPending += delta;
    }
  }

  // Accrual: playing counts, regardless of tab visibility
  timers.push(
    window.setInterval(() => {
      if (!stopped && !video.paused && !video.ended) watchedSecondsPending += 1;
    }, 1000),
  );
  timers.push(
    window.setInterval(() => {
      if (!stopped && !video.paused && !video.ended) {
        lastSentStopped = false;
        void report(false); // heartbeat also cancels any pending nudge
      }
    }, REPORT_INTERVAL_MS),
  );

  const onPause = () => void report(true);
  const onPlaying = () => {
    lastSentStopped = false;
    void report(false);
  };
  const onEnded = () => void report(true);
  const onPageHide = () => void report(true);
  video.addEventListener('pause', onPause);
  video.addEventListener('playing', onPlaying);
  video.addEventListener('ended', onEnded);
  window.addEventListener('pagehide', onPageHide);

  // Resume: seek to stored position; back off if the user seeks elsewhere
  if (resume) {
    const target = Math.min(resume.positionSeconds, video.duration - 5);
    let userSeeked = false;
    const onSeeking = () => {
      if (Math.abs(video.currentTime - target) > 2) userSeeked = true;
    };
    video.addEventListener('seeking', onSeeking);
    const startedAt = Date.now();
    const attempt = () => {
      if (userSeeked || Math.abs(video.currentTime - target) < 2) {
        video.removeEventListener('seeking', onSeeking);
        return;
      }
      video.currentTime = target;
      if (Date.now() - startedAt < RESUME_MAX_MS) {
        setTimeout(attempt, RESUME_RETRY_MS);
      } else {
        video.removeEventListener('seeking', onSeeking);
      }
    };
    attempt();
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      void report(true); // final flush for this video before the next session
      for (const t of timers) clearInterval(t);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('ended', onEnded);
      window.removeEventListener('pagehide', onPageHide);
    },
  };
}

export {};
