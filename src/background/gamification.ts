import { BADGES, type StatsSnapshot } from '../shared/badges';
import { NOTIFICATION_IDS } from '../shared/constants';
import { FREEZE_TOKEN_CAP } from '../shared/streakInsurance';
import { getLocal, getSettings, setLocal } from '../shared/storage';
import type { Gamification,  Streaks } from '../shared/types';

/**
 * Habit bookkeeping: lifetime counters + one-time milestones. Called from
 * every habit module (tracking, streaks, tasks, notes) — imports only
 * shared code and storage, so no import cycles.
 *
 * There used to be an XP economy, a level curve, and a weekly quest layered
 * on top of this. They were four visible scoreboards competing with the
 * streak, so they are gone; the counters survive because milestones and the
 * assistant's data snapshot read them. Milestones fire a notification once
 * and are never rendered as a wall of tiles.
 */

/** Habit events worth counting. Formerly XP-bearing; now counters only. */
export type HabitEvent =
  | 'article_finished'
  | 'video_finished'
  | 'sprint_completed'
  | 'task_completed'
  | 'braindump_structured'
  | 'focus_block'
;

const COUNTER_FOR_EVENT: Record<HabitEvent, keyof StatsSnapshot & string> = {
  article_finished: 'articlesFinished',
  video_finished: 'videosFinished',
  sprint_completed: 'sprints',
  task_completed: 'tasksCompleted',
  braindump_structured: 'brainDumps',
  focus_block: 'focusBlocks',
};

interface QueuedNotification {
  id: string;
  title: string;
  message: string;
}

function notify(queue: QueuedNotification[]): void {
  for (const n of queue) {
    chrome.notifications.create(n.id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: n.title,
      message: n.message,
      priority: 0,
    });
  }
}

interface Trio {
  gamification: Gamification;
  streaks: Streaks;
}

function snapshotOf({ gamification, streaks }: Trio): StatsSnapshot {
  return {
    ...gamification.counters,
    // ?? 0: profiles from before a counter existed may lack the key
    videosFinished: gamification.counters.videosFinished ?? 0,
    focusBlocks: gamification.counters.focusBlocks ?? 0,
    freezesEarned: gamification.counters.freezesEarned ?? 0,
    readingStreak: streaks.currentStreak,
  };
}

/** Unlock any newly-earned milestones; queues one notification per unlock */
function badgePass(state: Trio, queue: QueuedNotification[]): void {
  const snapshot = snapshotOf(state);
  for (const badge of BADGES) {
    if (!(badge.id in state.gamification.badges) && badge.earned(snapshot)) {
      state.gamification.badges[badge.id] = Date.now();
      queue.push({
        id: NOTIFICATION_IDS.badgePrefix + badge.id,
        title: `Milestone: ${badge.title}`,
        message: badge.description,
      });
    }
  }
}

/** Count a habit event and check whether it unlocked a milestone. */
export async function recordEvent(event: HabitEvent): Promise<void> {
  const { gamification, streaks } = await getLocal('gamification', 'streaks');
  const settings = await getSettings();
  const queue: QueuedNotification[] = [];

  const counterKey = COUNTER_FOR_EVENT[event] as keyof typeof gamification.counters;
  // ?? 0: profiles from before a counter existed may lack the key
  gamification.counters[counterKey] = (gamification.counters[counterKey] ?? 0) + 1;

  badgePass({ gamification, streaks }, queue);

  await setLocal({ gamification });
  if (settings.notificationsEnabled) notify(queue);
}

/** Inverse of recordEvent for undo paths (gym undo, task un-complete). Milestones stay. */
export async function revokeEvent(event: HabitEvent): Promise<void> {
  const { gamification } = await getLocal('gamification');
  const counterKey = COUNTER_FOR_EVENT[event] as keyof typeof gamification.counters;
  gamification.counters[counterKey] = Math.max(0, (gamification.counters[counterKey] ?? 0) - 1);
  await setLocal({ gamification });
}

/**
 * The variable-ratio drop (see shared/chests.ts): bank one streak freeze
 * token. No-op at the cap, so a lucky run can't stockpile immunity. Granted
 * once per task and never revoked — un-completing a task must not claw back a
 * token the user may already have spent.
 */
export async function grantFreezeToken(): Promise<void> {
  const { gamification, streaks } = await getLocal('gamification', 'streaks');
  if ((streaks.freezeTokens ?? 0) >= FREEZE_TOKEN_CAP) return;

  streaks.freezeTokens = (streaks.freezeTokens ?? 0) + 1;
  gamification.counters.freezesEarned = (gamification.counters.freezesEarned ?? 0) + 1;

  const settings = await getSettings();
  const queue: QueuedNotification[] = [
    {
      id: NOTIFICATION_IDS.chest,
      title: 'Streak freeze banked',
      message: `That completion dropped a freeze token — ${streaks.freezeTokens} in the bank.`,
    },
  ];
  badgePass({ gamification, streaks }, queue);

  await setLocal({ gamification, streaks });
  if (settings.notificationsEnabled) notify(queue);
}

/** Milestone-only evaluation for events that carry no counter (e.g. reading day qualified) */
export async function checkBadges(): Promise<void> {
  const state = await getLocal('gamification', 'streaks');
  const settings = await getSettings();
  const queue: QueuedNotification[] = [];

  badgePass(state, queue);
  if (queue.length > 0) {
    await setLocal({ gamification: state.gamification });
    if (settings.notificationsEnabled) notify(queue);
  }
}
