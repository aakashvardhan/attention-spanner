import { ALARMS, NOTIFICATION_IDS } from '../shared/constants';
import { daysAgo, localDate } from '../shared/format';
import { getLocal, getSettings, setLocal, setSession } from '../shared/storage';
import { rollChest } from '../shared/chests';
import { bridgeGap, maybeEarnToken } from '../shared/streakInsurance';
import type { DayStats, Streaks } from '../shared/types';
import { awardChest, awardXp, checkBadges } from './gamification';

/**
 * Daily reading stats + streaks. A day "qualifies" once active reading
 * reaches the daily goal OR at least one sprint finished. Streaks extend
 * only across consecutive local calendar days.
 */

/** A full year so the dashboard activity calendar has data to show */
const DAILY_WINDOW_DAYS = 365;

function emptyDay(): DayStats {
  return { minutes: 0, sprints: 0, articlesFinished: 0 };
}

function pruneDaily(streaks: Streaks): void {
  const cutoff = localDate(daysAgo(DAILY_WINDOW_DAYS));
  for (const date of Object.keys(streaks.daily)) {
    if (date < cutoff) delete streaks.daily[date];
  }
}

async function bumpToday(mutate: (day: DayStats) => void): Promise<void> {
  const { streaks } = await getLocal('streaks');
  const settings = await getSettings();
  const today = localDate();
  const yesterday = localDate(daysAgo(1));

  const day = streaks.daily[today] ?? emptyDay();
  mutate(day);
  streaks.daily[today] = day;

  const qualifies = day.minutes >= settings.dailyGoalMinutes || day.sprints >= 1;
  let newlyQualified = false;
  let bridge = { bridged: false, tokensSpent: 0 };
  if (qualifies && streaks.lastQualifiedDate !== today) {
    // Freeze tokens can pull lastQualifiedDate up to yesterday, turning a
    // qualify-after-gap into a normal extension instead of a reset to 1
    bridge = bridgeGap(streaks, today);
    streaks.currentStreak =
      streaks.lastQualifiedDate === yesterday ? streaks.currentStreak + 1 : 1;
    streaks.lastQualifiedDate = today;
    streaks.longestStreak = Math.max(streaks.longestStreak, streaks.currentStreak);
    maybeEarnToken(streaks);
    newlyQualified = true;
  }

  pruneDaily(streaks);
  await setLocal({ streaks });
  if (bridge.bridged) {
    await notifyStreakFrozen(bridge.tokensSpent, streaks.freezeTokens ?? 0);
  }
  if (newlyQualified) {
    // Reading-streak badges can advance on minutes-only days with no XP event
    await checkBadges();
  }
}

async function notifyStreakFrozen(tokensSpent: number, tokensLeft: number): Promise<void> {
  const settings = await getSettings();
  if (!settings.notificationsEnabled) return;
  chrome.notifications.create(NOTIFICATION_IDS.streakFreeze, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: 'Streak protected',
    message: `A freeze token covered ${tokensSpent === 1 ? 'a missed day' : `${tokensSpent} missed days`} — your streak lives. ${tokensLeft} left.`,
    priority: 0,
  });
}

export async function recordReading(activeSeconds: number, articleFinished: boolean): Promise<void> {
  if (activeSeconds <= 0 && !articleFinished) return;
  await bumpToday((day) => {
    day.minutes += activeSeconds / 60;
    if (articleFinished) day.articlesFinished += 1;
  });
}

/** Video watch minutes count toward the daily goal; articlesFinished stays untouched */
export async function recordWatching(watchedSeconds: number, videoFinished: boolean): Promise<void> {
  if (watchedSeconds <= 0 && !videoFinished) return;
  await bumpToday((day) => {
    day.minutes += watchedSeconds / 60;
    if (videoFinished) day.videosFinished = (day.videosFinished ?? 0) + 1;
  });
}

/** Focus blocks feed the weekly quest; they do NOT change day qualification */
export async function recordFocusBlock(): Promise<void> {
  await bumpToday((day) => {
    day.focusBlocks = (day.focusBlocks ?? 0) + 1;
  });
}

export async function recordSprintFinished(): Promise<void> {
  await bumpToday((day) => {
    day.sprints += 1;
  });
}

/** Task completions feed the activity calendar; they do NOT change day qualification */
export async function recordTaskToggled(delta: 1 | -1): Promise<void> {
  await bumpToday((day) => {
    day.tasksCompleted = Math.max(0, (day.tasksCompleted ?? 0) + delta);
  });
}

/**
 * On browser startup: a streak whose last qualified day is before yesterday
 * is broken — unless freeze tokens can bridge the gap (one per missed day).
 */
export async function recomputeStreak(): Promise<void> {
  const { streaks } = await getLocal('streaks');
  const today = localDate();
  const yesterday = localDate(daysAgo(1));
  if (
    streaks.currentStreak > 0 &&
    streaks.lastQualifiedDate !== today &&
    streaks.lastQualifiedDate !== yesterday
  ) {
    const bridge = bridgeGap(streaks, today);
    if (!bridge.bridged) {
      streaks.currentStreak = 0;
    }
    await setLocal({ streaks });
    if (bridge.bridged) {
      await notifyStreakFrozen(bridge.tokensSpent, streaks.freezeTokens ?? 0);
    }
  }
}

// ---- Sprints ----

export async function startSprint(): Promise<{ ok: boolean }> {
  const settings = await getSettings();
  await setSession({
    activeSprint: { startedAt: Date.now(), durationMin: settings.sprintMinutes },
  });
  chrome.alarms.create(ALARMS.sprintEnd, { delayInMinutes: settings.sprintMinutes });
  return { ok: true };
}

export async function cancelSprint(): Promise<{ ok: boolean }> {
  await chrome.alarms.clear(ALARMS.sprintEnd);
  await setSession({ activeSprint: null });
  return { ok: true };
}

export async function finishSprint(): Promise<void> {
  await setSession({ activeSprint: null });
  await recordSprintFinished();
  await awardXp('sprint_completed');
  // Sprints can't be un-finished, so a fresh roll per sprint is farm-safe
  const chestBonus = rollChest();
  if (chestBonus !== null) await awardChest(chestBonus);

  const settings = await getSettings();
  if (!settings.notificationsEnabled) return;
  const { streaks } = await getLocal('streaks');
  chrome.notifications.create(NOTIFICATION_IDS.sprintDone, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: 'Sprint done',
    message:
      streaks.currentStreak > 1
        ? `That keeps your ${streaks.currentStreak}-day streak alive.`
        : 'Today counts toward your streak.',
    priority: 0,
  });
}
