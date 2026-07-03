import type { ResumeTarget } from '../shared/messages';
import { getLocal, getSession, setLocal, setSession } from '../shared/storage';
import type { AnyProgress, ReadingProgress } from '../shared/types';
import { normalizeUrl } from '../shared/urlNormalize';
import { getYouTubeVideoId, isYouTubeWatchUrl, videoKey } from '../shared/youtube';
import { awardXp } from './gamification';
import { recordEngagement } from './hyperfocus';
import { pushReadingFinished } from './notion';
import { scheduleNudge, cancelNudge } from './nudges';
import { recordReading } from './streaks';

/**
 * Reading-progress tracking. The tracker content script is injected
 * dynamically (chrome.scripting.executeScript) only into tabs whose URL
 * matches a known article — never statically into every page.
 *
 * readingProgress is keyed by normalized URL. Tabs opened by the extension
 * keep the feed link's normalized URL as their key even if the site
 * redirects, via the trackedTabs tabId → key map in storage.session.
 */

const COMPLETE_PERCENT = 90;
const MAX_PROGRESS_ENTRIES = 100;
const COMPLETED_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const STALE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Called from openArticle: remember the tab we created and its resume target */
export async function registerOpenedTab(
  tabId: number,
  url: string,
  resume: boolean,
): Promise<void> {
  const ytId = getYouTubeVideoId(url);
  const key = ytId ? videoKey(ytId) : normalizeUrl(url);
  const { trackedTabs, pendingResume } = await getSession('trackedTabs', 'pendingResume');
  trackedTabs[tabId] = { normalizedUrl: key, injectedAt: 0 };

  if (resume) {
    const { readingProgress } = await getLocal('readingProgress');
    const progress = readingProgress[key];
    if (progress?.kind === 'video') {
      pendingResume[tabId] = { positionSeconds: progress.positionSeconds };
    } else if (progress && progress.pageHeight > 0) {
      pendingResume[tabId] = { scrollY: progress.scrollY, percent: progress.maxPercent };
    }
  }
  await setSession({ trackedTabs, pendingResume });
}

/** tabs.onUpdated(status === 'complete'): inject the tracker if this is a known article */
export async function maybeInjectTracker(tabId: number, url: string): Promise<void> {
  if (!/^https?:/.test(url)) return;
  // YouTube watch pages get the video tracker; scroll percent is meaningless there
  if (isYouTubeWatchUrl(url)) return;

  const tabNorm = normalizeUrl(url);
  const { trackedTabs } = await getSession('trackedTabs');
  let key: string | null = trackedTabs[tabId]?.normalizedUrl ?? null;

  if (!key) {
    // Organically opened tab — is it a known article?
    const { cachedItems, readingProgress } = await getLocal('cachedItems', 'readingProgress');
    if (readingProgress[tabNorm] || cachedItems.some((item) => item.normalizedLink === tabNorm)) {
      key = tabNorm;
    }
  }
  if (!key) return;

  trackedTabs[tabId] = { normalizedUrl: key, injectedAt: Date.now() };
  await setSession({ trackedTabs });

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/readingTracker.js'],
    });
  } catch (error) {
    // Restricted page (Web Store, PDF viewer, …) — nothing to track
    console.warn('[tracking] injection failed for', url, error);
  }
}

export async function handleTabRemoved(tabId: number): Promise<void> {
  const { trackedTabs, pendingResume } = await getSession('trackedTabs', 'pendingResume');
  if (!(tabId in trackedTabs) && !(tabId in pendingResume)) return;
  delete trackedTabs[tabId];
  delete pendingResume[tabId];
  await setSession({ trackedTabs, pendingResume });
}

/** TRACKER_READY: hand the content script its resume target (once) */
export async function getResumeTarget(tabId: number): Promise<ResumeTarget | null> {
  const { pendingResume } = await getSession('pendingResume');
  const target = pendingResume[tabId];
  if (!target || 'positionSeconds' in target) return null; // video targets belong to the video tracker
  delete pendingResume[tabId];
  await setSession({ pendingResume });

  const { trackedTabs } = await getSession('trackedTabs');
  const key = trackedTabs[tabId]?.normalizedUrl;
  if (!key) return null;
  const { readingProgress } = await getLocal('readingProgress');
  const progress = readingProgress[key];
  if (!progress || progress.kind === 'video') return null;
  return { scrollY: progress.scrollY, pageHeight: progress.pageHeight };
}

async function keyForTab(tabId: number, tabUrl: string | undefined): Promise<string | null> {
  const { trackedTabs } = await getSession('trackedTabs');
  if (trackedTabs[tabId]) return trackedTabs[tabId].normalizedUrl;
  // Session map lost (e.g. browser restarted mid-session) — fall back to the URL
  if (tabUrl && /^https?:/.test(tabUrl)) return normalizeUrl(tabUrl);
  return null;
}

export async function handleProgressUpdate(
  sender: chrome.runtime.MessageSender,
  update: {
    percent: number;
    scrollY: number;
    pageHeight: number;
    activeSecondsDelta: number;
    hidden: boolean;
  },
): Promise<void> {
  const tab = sender.tab;
  if (!tab?.id) return;
  const key = await keyForTab(tab.id, tab.url);
  if (!key) return;

  const { readingProgress, cachedItems } = await getLocal('readingProgress', 'cachedItems');
  const now = Date.now();

  const existing = readingProgress[key];
  if (existing?.kind === 'video') return; // normalized keys never hold videos; belt and braces
  let progress: ReadingProgress | undefined = existing;
  if (!progress) {
    const feedItem = cachedItems.find((item) => item.normalizedLink === key);
    progress = {
      url: tab.url ?? feedItem?.link ?? '',
      feedItemId: feedItem?.id ?? null,
      title: tab.title ?? feedItem?.title ?? '',
      source: feedItem?.source ?? '',
      maxPercent: 0,
      scrollY: 0,
      pageHeight: 0,
      activeSeconds: 0,
      firstOpenedAt: now,
      updatedAt: now,
      completedAt: null,
      nudge: { count: 0, lastAt: 0, dismissed: false },
    };
  }

  if (tab.title) progress.title = tab.title;
  if (tab.url) progress.url = tab.url;
  progress.maxPercent = Math.max(progress.maxPercent, Math.round(update.percent));
  progress.scrollY = update.scrollY;
  progress.pageHeight = update.pageHeight;
  progress.activeSeconds += Math.max(0, update.activeSecondsDelta);
  progress.updatedAt = now;
  let finishedNow = false;
  if (progress.completedAt === null && progress.maxPercent >= COMPLETE_PERCENT) {
    progress.completedAt = now;
    finishedNow = true;
  }

  readingProgress[key] = progress;
  await setLocal({ readingProgress: prune(readingProgress) });
  await recordReading(Math.max(0, update.activeSecondsDelta), finishedNow);
  await recordEngagement(Math.max(0, update.activeSecondsDelta), update.hidden);
  if (finishedNow) {
    await awardXp('article_finished'); // latches once per article via completedAt
    void pushReadingFinished(progress);
  }

  if (update.hidden) {
    await scheduleNudge(key);
  } else {
    await cancelNudge(key);
  }
}

export function prune(progress: Record<string, AnyProgress>): Record<string, AnyProgress> {
  const now = Date.now();
  let entries = Object.entries(progress).filter(([, p]) => {
    if (p.completedAt !== null) return now - p.completedAt < COMPLETED_TTL_MS;
    return now - p.updatedAt < STALE_TTL_MS;
  });
  if (entries.length > MAX_PROGRESS_ENTRIES) {
    entries = entries
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_PROGRESS_ENTRIES);
  }
  return Object.fromEntries(entries);
}
