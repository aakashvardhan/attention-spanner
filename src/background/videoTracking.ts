import { getLocal, getSession, getSettings, setLocal, setSession } from '../shared/storage';
import type { VideoProgress } from '../shared/types';
import { getYouTubeVideoId, isYouTubeWatchUrl, videoKey } from '../shared/youtube';
import { awardXp } from './gamification';
import { recordEngagement } from './hyperfocus';
import { pushReadingFinished } from './notion';
import { cancelNudge, scheduleNudge } from './nudges';
import { prune } from './tracking';
import { recordWatching } from './streaks';

/**
 * YouTube watch tracking. The SW's only injection job is getting
 * videoTracker.js into the tab once (the in-page guard makes repeats
 * harmless); the content script owns SPA navigation detection and sends
 * videoId explicitly with every message, so identity can never desync.
 */

const COMPLETE_PERCENT = 90;
const MIN_RESUME_SECONDS = 30;

export async function maybeInjectVideoTracker(tabId: number, url: string): Promise<void> {
  if (!isYouTubeWatchUrl(url)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/videoTracker.js'],
    });
  } catch (error) {
    console.warn('[videoTracking] injection failed for', url, error);
  }
}

/** Gate + resume handshake. The duration threshold lives here — settings stay SW-owned. */
export async function handleVideoReady(
  sender: chrome.runtime.MessageSender,
  msg: { videoId: string; durationSeconds: number },
): Promise<{ ok: boolean; track: boolean; resume: { positionSeconds: number } | null }> {
  const settings = await getSettings();
  const longEnough =
    Number.isFinite(msg.durationSeconds) &&
    msg.durationSeconds >= settings.videoMinMinutes * 60;
  if (!longEnough) return { ok: true, track: false, resume: null };

  // Prefer an explicit pending resume (tab opened from Continue Watching / nudge)
  let resume: { positionSeconds: number } | null = null;
  const tabId = sender.tab?.id;
  if (tabId !== undefined) {
    const { pendingResume } = await getSession('pendingResume');
    const target = pendingResume[tabId];
    if (target && 'positionSeconds' in target) {
      resume = { positionSeconds: target.positionSeconds };
      delete pendingResume[tabId];
      await setSession({ pendingResume });
    }
  }

  // Otherwise resume from the stored record — organic re-opens resume too
  if (!resume) {
    const { readingProgress } = await getLocal('readingProgress');
    const progress = readingProgress[videoKey(msg.videoId)];
    if (
      progress?.kind === 'video' &&
      progress.completedAt === null &&
      progress.positionSeconds > MIN_RESUME_SECONDS
    ) {
      resume = { positionSeconds: progress.positionSeconds };
    }
  }

  return { ok: true, track: true, resume };
}

export async function handleVideoProgress(
  sender: chrome.runtime.MessageSender,
  msg: {
    videoId: string;
    positionSeconds: number;
    durationSeconds: number;
    watchedSecondsDelta: number;
    stopped: boolean;
    title: string;
    channel: string;
  },
): Promise<void> {
  const key = videoKey(msg.videoId);
  const { readingProgress } = await getLocal('readingProgress');
  const now = Date.now();

  const existing = readingProgress[key];
  let progress: VideoProgress;
  if (existing?.kind === 'video') {
    progress = existing;
  } else {
    progress = {
      kind: 'video',
      videoId: msg.videoId,
      url: sender.tab?.url ?? `https://www.youtube.com/watch?v=${msg.videoId}`,
      title: msg.title,
      source: msg.channel,
      maxPercent: 0,
      durationSeconds: msg.durationSeconds,
      positionSeconds: 0,
      activeSeconds: 0,
      firstOpenedAt: now,
      updatedAt: now,
      completedAt: null,
      nudge: { count: 0, lastAt: 0, dismissed: false },
    };
  }

  if (msg.title) progress.title = msg.title;
  if (msg.channel) progress.source = msg.channel;
  if (sender.tab?.url) progress.url = sender.tab.url;
  progress.durationSeconds = msg.durationSeconds;
  progress.positionSeconds = msg.positionSeconds;
  progress.maxPercent = Math.max(
    progress.maxPercent,
    Math.min(100, Math.floor((msg.positionSeconds / msg.durationSeconds) * 100)),
  );
  progress.activeSeconds += Math.max(0, msg.watchedSecondsDelta);
  progress.updatedAt = now;
  let finishedNow = false;
  if (progress.completedAt === null && progress.maxPercent >= COMPLETE_PERCENT) {
    progress.completedAt = now;
    finishedNow = true;
  }

  readingProgress[key] = progress;
  await setLocal({ readingProgress: prune(readingProgress) });
  await recordWatching(Math.max(0, msg.watchedSecondsDelta), finishedNow);
  await recordEngagement(Math.max(0, msg.watchedSecondsDelta), msg.stopped);
  if (finishedNow) {
    await awardXp('video_finished');
    void pushReadingFinished(progress);
  }

  if (msg.stopped) {
    await scheduleNudge(key);
  } else {
    await cancelNudge(key);
  }
}

/** Nudge-resume path: focus an open tab with this video, else reopen at &t= */
export async function resumeVideo(progress: VideoProgress): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['*://*.youtube.com/*', '*://youtu.be/*'] });
  const existing = tabs.find(
    (tab) => tab.url && getYouTubeVideoId(tab.url) === progress.videoId,
  );
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }

  const t = Math.max(0, Math.floor(progress.positionSeconds));
  const tab = await chrome.tabs.create({
    url: `https://www.youtube.com/watch?v=${progress.videoId}&t=${t}s`,
  });
  if (tab.id !== undefined) {
    // Handshake resume is more precise than &t=; harmless double
    const { trackedTabs, pendingResume } = await getSession('trackedTabs', 'pendingResume');
    trackedTabs[tab.id] = { normalizedUrl: videoKey(progress.videoId), injectedAt: 0 };
    pendingResume[tab.id] = { positionSeconds: progress.positionSeconds };
    await setSession({ trackedTabs, pendingResume });
  }
}
