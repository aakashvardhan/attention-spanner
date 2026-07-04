import { GYM_WINDOW_DAYS, NOTIFICATION_IDS } from '../shared/constants';
import { daysAgo, localDate } from '../shared/format';
import { getLocal, getSettings, setLocal } from '../shared/storage';
import { countInWeek, prevWeekKey, weekKey } from '../shared/week';
import { awardXp, revokeXp } from './gamification';

/**
 * Gym check-ins + weekly-goal streak. A week qualifies the instant its Nth
 * check-in lands (N = settings.gymWeeklyTarget); the streak counts
 * consecutive qualified weeks, so rest days are irrelevant by construction.
 */

function pruneCheckins(checkins: Record<string, number>): void {
  const cutoff = localDate(daysAgo(GYM_WINDOW_DAYS));
  for (const date of Object.keys(checkins)) {
    if (date < cutoff) delete checkins[date];
  }
}

export async function gymCheckin(): Promise<{ ok: boolean }> {
  const { gym } = await getLocal('gym');
  const settings = await getSettings();
  const today = localDate();
  if (gym.checkins[today]) return { ok: true }; // one per day

  gym.checkins[today] = Date.now();

  const thisWeek = weekKey();
  const count = countInWeek(gym.checkins, thisWeek);
  if (count >= settings.gymWeeklyTarget && gym.lastQualifiedWeek !== thisWeek) {
    gym.currentWeekStreak =
      gym.lastQualifiedWeek === prevWeekKey(thisWeek) ? gym.currentWeekStreak + 1 : 1;
    gym.lastQualifiedWeek = thisWeek;
    gym.longestWeekStreak = Math.max(gym.longestWeekStreak, gym.currentWeekStreak);
  }

  pruneCheckins(gym.checkins);
  await setLocal({ gym });
  await awardXp('gym_checkin');
  return { ok: true };
}

/** Same-day undo. Reverses XP and, if needed, this week's qualification. */
export async function gymUndo(): Promise<{ ok: boolean }> {
  const { gym } = await getLocal('gym');
  const settings = await getSettings();
  const today = localDate();
  if (!gym.checkins[today]) return { ok: true };

  delete gym.checkins[today];

  const thisWeek = weekKey();
  if (
    gym.lastQualifiedWeek === thisWeek &&
    countInWeek(gym.checkins, thisWeek) < settings.gymWeeklyTarget
  ) {
    // Exact inverse of qualification; if streak > 1 the previous week qualified
    gym.currentWeekStreak -= 1;
    gym.lastQualifiedWeek = gym.currentWeekStreak > 0 ? prevWeekKey(thisWeek) : '';
    // longestWeekStreak intentionally untouched (never revoked, like badges)
  }

  await setLocal({ gym });
  await revokeXp('gym_checkin');
  return { ok: true };
}

/** On startup: streak breaks only once a full week has ended short */
export async function recomputeGymStreak(): Promise<void> {
  const { gym } = await getLocal('gym');
  const thisWeek = weekKey();
  if (
    gym.currentWeekStreak > 0 &&
    gym.lastQualifiedWeek !== thisWeek &&
    gym.lastQualifiedWeek !== prevWeekKey(thisWeek)
  ) {
    gym.currentWeekStreak = 0;
    await setLocal({ gym });
  }
}

/** Daily reminder; every gate re-checked at fire time */
export async function fireGymReminder(): Promise<void> {
  const settings = await getSettings();
  if (!settings.notificationsEnabled || settings.gymReminderTime === '') return;

  const { gym } = await getLocal('gym');
  const today = localDate();
  if (gym.checkins[today]) return; // already went

  const thisWeek = weekKey();
  const count = countInWeek(gym.checkins, thisWeek);
  if (count >= settings.gymWeeklyTarget) return; // week's done — guilt-free rest

  const remaining = settings.gymWeeklyTarget - count;
  const streakPart =
    gym.currentWeekStreak > 0
      ? ` to keep your ${gym.currentWeekStreak}-week streak`
      : ' this week';
  chrome.notifications.create(NOTIFICATION_IDS.gymReminder, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: 'Gym today? 💪',
    message: `${remaining} more session${remaining === 1 ? '' : 's'}${streakPart}.`,
    buttons: [{ title: '💪 I went today' }, { title: 'Snooze 1h' }],
    priority: 0,
  });
}
