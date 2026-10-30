import {
  ALARMS,
  NOTIFICATION_IDS,
  NUDGE_COOLDOWN_MINUTES,
  NUDGE_DELAY_MINUTES,
  NUDGE_MAX_PER_ARTICLE,
} from '../shared/constants';
import { formatWatchTime } from '../shared/format';
import { paperOpenUrl } from '../shared/pdf';
import { getLocal, getSession, getSettings, setLocal, setSession } from '../shared/storage';
import type { Paper } from '../shared/types';
import { normalizeUrl } from '../shared/urlNormalize';
import { videoCategory } from '../shared/videoCategory';
import { driftedAway, keyMatchesUrl } from '../shared/youtube';

/**
 * Tab-switch nudges. Anti-spam is the whole design: a nudge only fires after
 * a quiet delay, and only if it passes every gate at fire time — progress
 * window, minimum engagement, per-article cooldown + cap + dismiss, global
 * rate cap, and the settings toggles.
 */

const MIN_PERCENT = 5;
const MAX_PERCENT = 90;
const MIN_ACTIVE_SECONDS = 30;
export const GLOBAL_NUDGE_GAP_MS = 10 * 60 * 1000;

/** Papers nudge under `paper:<id>`; everything else is a readingProgress key. */
export const PAPER_NUDGE_PREFIX = 'paper:';

const alarmName = (key: string) => ALARMS.nudgePrefix + key;
const notificationName = (key: string) => NOTIFICATION_IDS.nudgePrefix + key;

type NudgeState = { count: number; lastAt: number; dismissed: boolean };
const FRESH_NUDGE: NudgeState = { count: 0, lastAt: 0, dismissed: false };

/** Every per-item and global gate, pure so it is a unit test. */
export function nudgeEligible(
  item: { percent: number; unfinished: boolean; activeSeconds: number; nudge: NudgeState },
  lastGlobalNudgeAt: number,
  now: number,
): boolean {
  return (
    item.unfinished &&
    item.percent >= MIN_PERCENT &&
    item.percent < MAX_PERCENT &&
    item.activeSeconds >= MIN_ACTIVE_SECONDS &&
    !item.nudge.dismissed &&
    item.nudge.count < NUDGE_MAX_PER_ARTICLE &&
    now - item.nudge.lastAt > NUDGE_COOLDOWN_MINUTES * 60 * 1000 &&
    now - lastGlobalNudgeAt > GLOBAL_NUDGE_GAP_MS
  );
}

/** The item went out of view — start the countdown */
export async function scheduleNudge(key: string): Promise<void> {
  const settings = await getSettings();
  if (!settings.notificationsEnabled || !settings.nudgesEnabled) return;
  // A lecture playing in a hidden tab reports every 5s; recreating the alarm
  // each time would push the countdown back forever.
  if (await chrome.alarms.get(alarmName(key))) return;
  chrome.alarms.create(alarmName(key), {
    delayInMinutes: NUDGE_DELAY_MINUTES,
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

  if (key.startsWith(PAPER_NUDGE_PREFIX)) return firePaperNudge(key);

  const { readingProgress } = await getLocal('readingProgress');
  const progress = readingProgress[key];
  if (!progress) return;

  const now = Date.now();
  const { lastGlobalNudgeAt } = await getSession('lastGlobalNudgeAt');

  const eligible = nudgeEligible(
    {
      percent: progress.maxPercent,
      unfinished: progress.completedAt === null,
      activeSeconds: progress.activeSeconds,
      nudge: progress.nudge,
    },
    lastGlobalNudgeAt,
    now,
  );
  if (!eligible) return;

  // Zoned out: the video kept playing in a tab nobody was looking at. Music
  // and podcasts playing on in the background are the point; only study
  // material counts as drifting off.
  const lookedAwayAt =
    progress.kind === 'video' && progress.playing === true ? progress.lookedAwayAt : undefined;
  if (lookedAwayAt !== undefined && videoCategory(progress.title, progress.source) === 'Other') return;

  // If the article/video is front-and-center right now, don't nag
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab?.url && keyMatchesUrl(key, activeTab.url)) return;

  progress.nudge.count += 1;
  progress.nudge.lastAt = now;
  readingProgress[key] = progress;
  await setLocal({ readingProgress });
  await setSession({ lastGlobalNudgeAt: now });

  const isVideo = progress.kind === 'video';
  if (lookedAwayAt !== undefined) {
    chrome.notifications.create(notificationName(key), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: 'Still listening?',
      message: `"${progress.title}" kept playing since ${formatWatchTime(lookedAwayAt)}.`,
      contextMessage: progress.source || undefined,
      buttons: [{ title: `Rewind to ${formatWatchTime(lookedAwayAt)}` }, { title: "Don't remind me for this video" }],
      priority: 0,
    });
    return;
  }
  // Drift — left the video but stayed on YouTube — is a different situation
  // from closing the tab, and only the wording changes. Every gate above still
  // applies, so this cannot become a second, chattier notification channel.
  const drifted = driftedAway(key, activeTab?.url);
  chrome.notifications.create(notificationName(key), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: drifted ? 'Still on YouTube?' : 'Pick it back up?',
    message: drifted
      ? `You left "${progress.title}" at ${progress.maxPercent}% and moved on.`
      : isVideo
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

async function firePaperNudge(key: string): Promise<void> {
  const found = await findPaper(key);
  if (!found) return;
  const { papers, paper } = found;

  const now = Date.now();
  const { lastGlobalNudgeAt } = await getSession('lastGlobalNudgeAt');
  const nudge = paper.nudge ?? { ...FRESH_NUDGE };
  const eligible = nudgeEligible(
    // Papers carry no active-seconds count; a reader that reported progress was read.
    { percent: paper.progressPercent, unfinished: paper.status === 'reading', activeSeconds: Infinity, nudge },
    lastGlobalNudgeAt,
    now,
  );
  if (!eligible) return;

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab?.url && activeTab.url === paperOpenUrl(paper)) return;

  paper.nudge = { ...nudge, count: nudge.count + 1, lastAt: now };
  await setLocal({ papers });
  await setSession({ lastGlobalNudgeAt: now });

  chrome.notifications.create(notificationName(key), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: 'Pick it back up?',
    message: paper.leftOff
      ? `You were on "${paper.leftOff}" in "${paper.title}"`
      : `You were ${Math.round(paper.progressPercent)}% through "${paper.title}"`,
    contextMessage: paper.venue || undefined,
    buttons: [{ title: 'Resume' }, { title: "Don't remind me for this paper" }],
    priority: 0,
  });
}

async function findPaper(key: string): Promise<{ papers: Paper[]; paper: Paper } | null> {
  const id = key.slice(PAPER_NUDGE_PREFIX.length);
  const { papers } = await getLocal('papers');
  const paper = papers.find((p) => p.id === id);
  return paper ? { papers, paper } : null;
}

export function isNudgeNotification(notificationId: string): boolean {
  return notificationId.startsWith(NOTIFICATION_IDS.nudgePrefix);
}

export async function resumeArticle(key: string): Promise<void> {
  if (key.startsWith(PAPER_NUDGE_PREFIX)) {
    const found = await findPaper(key);
    if (!found) return;
    const url = paperOpenUrl(found.paper);
    // Match patterns can't name chrome-extension:// pages, so filter by hand.
    const open = (await chrome.tabs.query({})).find((tab) => tab.url === url);
    if (open?.id !== undefined) {
      await chrome.tabs.update(open.id, { active: true });
      if (open.windowId !== undefined) await chrome.windows.update(open.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
    return;
  }

  const { readingProgress } = await getLocal('readingProgress');
  const progress = readingProgress[key];
  if (!progress) return;

  if (progress.kind === 'video') {
    // Lazy import avoids a require cycle (videoTracking imports scheduleNudge)
    const { resumeVideo } = await import('./videoTracking');
    // Zoned out of a lecture: go back to where attention left, not where it is now.
    const rewindTo = progress.playing === true ? progress.lookedAwayAt : undefined;
    await resumeVideo(rewindTo === undefined ? progress : { ...progress, positionSeconds: rewindTo }, rewindTo !== undefined);
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
  if (key.startsWith(PAPER_NUDGE_PREFIX)) {
    const found = await findPaper(key);
    if (!found) return;
    found.paper.nudge = { ...(found.paper.nudge ?? FRESH_NUDGE), dismissed: true };
    await setLocal({ papers: found.papers });
    return;
  }

  const { readingProgress } = await getLocal('readingProgress');
  const progress = readingProgress[key];
  if (!progress) return;
  progress.nudge.dismissed = true;
  readingProgress[key] = progress;
  await setLocal({ readingProgress });
}
