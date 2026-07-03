import { ALARMS, NOTIFICATION_IDS } from '../shared/constants';
import { getLocal, getSession, getSettings, setLocal, setSession } from '../shared/storage';
import { normalizeUrl } from '../shared/urlNormalize';
import { keyMatchesUrl } from '../shared/youtube';

/**
 * Tab-switch nudges. Anti-spam is the whole design: a nudge only fires after
 * a quiet delay, and only if it passes every gate at fire time — progress
 * window, minimum engagement, per-article cooldown + cap + dismiss, global
 * rate cap, and the settings toggles.
 */

const MIN_PERCENT = 5;
const MAX_PERCENT = 90;
const MIN_ACTIVE_SECONDS = 30;
const GLOBAL_NUDGE_GAP_MS = 10 * 60 * 1000;

const alarmName = (key: string) => ALARMS.nudgePrefix + key;
const notificationName = (key: string) => NOTIFICATION_IDS.nudgePrefix + key;

/** The article's tab went hidden — start the countdown */
export async function scheduleNudge(key: string): Promise<void> {
  const settings = await getSettings();
  if (!settings.notificationsEnabled || !settings.nudgesEnabled) return;
  chrome.alarms.create(alarmName(key), {
    delayInMinutes: Math.max(0.5, settings.nudgeDelayMinutes),
  });
}

/** The user is reading it again — call off the nudge */
export async function cancelNudge(key: string): Promise<void> {
  await chrome.alarms.clear(alarmName(key));
}

export function isNudgeAlarm(name: string): boolean {
  return name.startsWith(ALARMS.nudgePrefix);
}

export async function fireNudge(alarmNameFired: string): Promise<void> {
  const key = alarmNameFired.slice(ALARMS.nudgePrefix.length);

  const settings = await getSettings();
  if (!settings.notificationsEnabled || !settings.nudgesEnabled) return;

  const { readingProgress } = await getLocal('readingProgress');
  const progress = readingProgress[key];
  if (!progress) return;

  const now = Date.now();
  const { lastGlobalNudgeAt } = await getSession('lastGlobalNudgeAt');

  const eligible =
    progress.maxPercent >= MIN_PERCENT &&
    progress.maxPercent < MAX_PERCENT &&
    progress.completedAt === null &&
    progress.activeSeconds >= MIN_ACTIVE_SECONDS &&
    !progress.nudge.dismissed &&
    progress.nudge.count < settings.nudgeMaxPerArticle &&
    now - progress.nudge.lastAt > settings.nudgeCooldownMinutes * 60 * 1000 &&
    now - lastGlobalNudgeAt > GLOBAL_NUDGE_GAP_MS;
  if (!eligible) return;

  // If the article/video is front-and-center right now, don't nag
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab?.url && keyMatchesUrl(key, activeTab.url)) return;

  progress.nudge.count += 1;
  progress.nudge.lastAt = now;
  readingProgress[key] = progress;
  await setLocal({ readingProgress });
  await setSession({ lastGlobalNudgeAt: now });

  const isVideo = progress.kind === 'video';
  chrome.notifications.create(notificationName(key), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: 'Pick it back up?',
    message: isVideo
      ? `You're ${progress.maxPercent}% into "${progress.title}" — pick up where you left off?`
      : `You were ${progress.maxPercent}% through "${progress.title}"`,
    contextMessage: progress.source || undefined,
    buttons: [
      { title: 'Resume' },
      { title: isVideo ? "Don't remind me for this video" : "Don't remind me for this article" },
    ],
    priority: 0,
  });
}

export function isNudgeNotification(notificationId: string): boolean {
  return notificationId.startsWith(NOTIFICATION_IDS.nudgePrefix);
}

export async function resumeArticle(key: string): Promise<void> {
  const { readingProgress } = await getLocal('readingProgress');
  const progress = readingProgress[key];
  if (!progress) return;

  if (progress.kind === 'video') {
    // Lazy import avoids a require cycle (videoTracking imports scheduleNudge)
    const { resumeVideo } = await import('./videoTracking');
    await resumeVideo(progress);
    return;
  }

  // Focus the existing tab if the article is still open somewhere
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  const existing = tabs.find((tab) => tab.url && normalizeUrl(tab.url) === key);
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }

  // Otherwise reopen with scroll restore (lazy import avoids a require cycle)
  const { openArticle } = await import('./feeds');
  await openArticle(progress.url, null, true);
}

export async function dismissNudgesForArticle(key: string): Promise<void> {
  const { readingProgress } = await getLocal('readingProgress');
  const progress = readingProgress[key];
  if (!progress) return;
  progress.nudge.dismissed = true;
  readingProgress[key] = progress;
  await setLocal({ readingProgress });
}
