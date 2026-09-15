import { extensionAlive, sendMessage } from '../shared/messages';
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
    /**
     * Present while an instance is running. Calling it runs inside *that*
     * instance's closure, so it reports whether that instance's extension
     * context is still valid — something a replacement cannot see otherwise.
     */
    __readerVideoTrackerAlive?: () => boolean;
    __readerVideoTrackerStop?: () => void;
  }
}

const REPORT_INTERVAL_MS = 5000;
const PLAYER_RETRY_MS = 500;
const PLAYER_RETRY_MAX_MS = 15_000;
const RESUME_RETRY_MS = 500;
const RESUME_MAX_MS = 4000;
/** How close counts as "already there" when seeking; also the forward-only margin */
const RESUME_TOLERANCE_SECONDS = 2;
const NAV_POLL_MS = 2000;

// A live instance still short-circuits the repeat injections that SPA
// navigation triggers. An orphaned one must be evicted instead: it can never
// report again, and the tab it is stuck in will not navigate on its own.
if (window.__readerVideoTrackerAlive?.() !== true) {
  window.__readerVideoTrackerStop?.();
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

  const alive = () => extensionAlive();
  const onNavigate = () => restartSession();

  const teardown = () => {
    clearInterval(navTimer);
    window.removeEventListener('yt-navigate-finish', onNavigate);
    session?.stop();
    session = null;
    currentVideoId = null;
    // Only disown the globals if they are still ours — a replacement that
    // evicted us has already installed its own.
    if (window.__readerVideoTrackerAlive === alive) {
      delete window.__readerVideoTrackerAlive;
      delete window.__readerVideoTrackerStop;
    }
  };

  const navTimer = window.setInterval(() => {
    // Self-evict rather than spin timers forever against a dead context
    if (!extensionAlive()) return teardown();
    restartSession();
  }, NAV_POLL_MS);

  window.addEventListener('yt-navigate-finish', onNavigate);
  window.__readerVideoTrackerAlive = alive;
  window.__readerVideoTrackerStop = teardown;
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

/**
 * The chapter the playhead is in, straight off the player's own readout.
 *
 * Chapters are NOT in the ytInitialPlayerResponse that youtubeCaptions.ts
 * parses — they live under ytInitialData's multiMarkersPlayerBarRenderer, which
 * would mean a second MAIN-world injection and another nested schema to chase.
 * The player already renders and updates this string, so read that instead.
 * Empty for the majority of videos, which have no chapters at all.
 */
function chapterName(): string {
  return document.querySelector('.ytp-chapter-title-content')?.textContent?.trim() ?? '';
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
        chapter: chapterName(),
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

  // Only ever seek forward. This script is now re-injected into tabs that are
  // already playing (extension reload, session restore), where the stored
  // position predates the gap — seeking to it would yank the viewer backward
  // by however long the tracker was orphaned.
  if (resume && resume.positionSeconds <= video.currentTime + RESUME_TOLERANCE_SECONDS) {
    resume = null;
  }

  // Resume: seek to stored position; back off if the user seeks elsewhere
  if (resume) {
    const target = Math.min(resume.positionSeconds, video.duration - 5);
    let userSeeked = false;
    const onSeeking = () => {
      if (Math.abs(video.currentTime - target) > RESUME_TOLERANCE_SECONDS) userSeeked = true;
    };
    video.addEventListener('seeking', onSeeking);
    const startedAt = Date.now();
    const attempt = () => {
      if (userSeeked || Math.abs(video.currentTime - target) < RESUME_TOLERANCE_SECONDS) {
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
