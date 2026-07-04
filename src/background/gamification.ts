import { BADGES, type StatsSnapshot } from '../shared/badges';
import { NOTIFICATION_IDS } from '../shared/constants';
import { levelForXp, QUEST_XP_BONUS, XP_VALUES, type XpEvent } from '../shared/levels';
import { questProgress } from '../shared/quest';
import { getLocal, getSettings, setLocal } from '../shared/storage';
import type { Gamification, GymState, Streaks } from '../shared/types';
import { weekKey } from '../shared/week';

/**
 * Unified XP/levels/badges/quest engine. Called from every habit module
 * (gym, tracking, streaks, tasks, notes) — imports only shared code and
 * storage, so no import cycles.
 */

const COUNTER_FOR_EVENT: Record<XpEvent, keyof StatsSnapshot & string> = {
  gym_checkin: 'workouts',
  article_finished: 'articlesFinished',
  video_finished: 'videosFinished',
  sprint_completed: 'sprints',
  task_completed: 'tasksCompleted',
  braindump_structured: 'brainDumps',
  focus_block: 'focusBlocks',
  flashcard_review: 'cardsReviewed',
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
  gym: GymState;
  streaks: Streaks;
}

function snapshotOf({ gamification, gym, streaks }: Trio): StatsSnapshot {
  return {
    ...gamification.counters,
    // ?? 0: profiles from before a counter existed may lack the key
    videosFinished: gamification.counters.videosFinished ?? 0,
    focusBlocks: gamification.counters.focusBlocks ?? 0,
    cardsReviewed: gamification.counters.cardsReviewed ?? 0,
    chestsOpened: gamification.counters.chestsOpened ?? 0,
    gymWeekStreak: gym.currentWeekStreak,
    readingStreak: streaks.currentStreak,
    level: levelForXp(gamification.xp).level,
  };
}

/** Unlock any newly-earned badges; queues one notification per unlock */
function badgePass(state: Trio, queue: QueuedNotification[]): void {
  const snapshot = snapshotOf(state);
  for (const badge of BADGES) {
    if (!(badge.id in state.gamification.badges) && badge.earned(snapshot)) {
      state.gamification.badges[badge.id] = Date.now();
      queue.push({
        id: NOTIFICATION_IDS.badgePrefix + badge.id,
        title: `Badge unlocked: ${badge.emoji} ${badge.title}`,
        message: badge.description,
      });
    }
  }
}

export async function awardXp(event: XpEvent): Promise<void> {
  const { gamification, gym, streaks } = await getLocal('gamification', 'gym', 'streaks');
  const settings = await getSettings();
  const queue: QueuedNotification[] = [];

  const counterKey = COUNTER_FOR_EVENT[event] as keyof typeof gamification.counters;
  // ?? 0: profiles from before a counter existed may lack the key
  gamification.counters[counterKey] = (gamification.counters[counterKey] ?? 0) + 1;

  const levelBefore = levelForXp(gamification.xp).level;
  gamification.xp += XP_VALUES[event];

  // Weekly quest — derived from live data, celebrated once per week
  const thisWeek = weekKey();
  const quest = questProgress(gym.checkins, streaks.daily, settings, thisWeek);
  if (quest.complete && gamification.lastQuestCelebratedWeek !== thisWeek) {
    gamification.lastQuestCelebratedWeek = thisWeek;
    gamification.xp += QUEST_XP_BONUS;
    queue.push({
      id: NOTIFICATION_IDS.questComplete,
      title: 'Weekly quest complete 🎉',
      message: `${quest.lines.map((l) => `${l.emoji} ${l.current}/${l.target}`).join(' · ')} — +${QUEST_XP_BONUS} XP`,
    });
  }

  const levelAfter = levelForXp(gamification.xp).level;
  if (levelAfter > levelBefore) {
    queue.push({
      id: NOTIFICATION_IDS.levelUp,
      title: `Level ${levelAfter}! ⭐`,
      message: `${gamification.xp} XP across reading, tasks, and the gym. Keep stacking.`,
    });
  }

  // Badge pass over the final snapshot (sees quest bonus / new level)
  badgePass({ gamification, gym, streaks }, queue);

  await setLocal({ gamification });
  if (settings.notificationsEnabled) notify(queue);
}

/**
 * Mystery-chest drop: bonus XP + lifetime chest counter + level/badge pass.
 * Callers decide when a chest may be rolled (see chests.ts + tasks.ts).
 */
export async function awardChest(bonusXp: number): Promise<void> {
  const { gamification, gym, streaks } = await getLocal('gamification', 'gym', 'streaks');
  const settings = await getSettings();
  const queue: QueuedNotification[] = [];

  gamification.counters.chestsOpened = (gamification.counters.chestsOpened ?? 0) + 1;
  const levelBefore = levelForXp(gamification.xp).level;
  gamification.xp += bonusXp;
  queue.push({
    id: NOTIFICATION_IDS.chest,
    title: '🎁 Mystery chest!',
    message: `+${bonusXp} bonus XP dropped from that completion.`,
  });

  const levelAfter = levelForXp(gamification.xp).level;
  if (levelAfter > levelBefore) {
    queue.push({
      id: NOTIFICATION_IDS.levelUp,
      title: `Level ${levelAfter}! ⭐`,
      message: `${gamification.xp} XP across reading, tasks, and the gym. Keep stacking.`,
    });
  }

  badgePass({ gamification, gym, streaks }, queue);
  await setLocal({ gamification });
  if (settings.notificationsEnabled) notify(queue);
}

/**
 * Raw XP delta for chest-bonus undo/redo on task re-toggles; counters,
 * badges, and quests stay untouched.
 */
export async function adjustXp(delta: number): Promise<void> {
  const { gamification } = await getLocal('gamification');
  gamification.xp = Math.max(0, gamification.xp + delta);
  await setLocal({ gamification });
}

/** Inverse of awardXp for undo paths (gym undo, task un-complete). Badges/quests stay. */
export async function revokeXp(event: XpEvent): Promise<void> {
  const { gamification } = await getLocal('gamification');
  const counterKey = COUNTER_FOR_EVENT[event] as keyof typeof gamification.counters;
  gamification.counters[counterKey] = Math.max(0, (gamification.counters[counterKey] ?? 0) - 1);
  gamification.xp = Math.max(0, gamification.xp - XP_VALUES[event]);
  await setLocal({ gamification });
}

/** Badge-only evaluation for events that carry no XP (e.g. reading day qualified) */
export async function checkBadges(): Promise<void> {
  const state = await getLocal('gamification', 'gym', 'streaks');
  const settings = await getSettings();
  const queue: QueuedNotification[] = [];

  badgePass(state, queue);
  if (queue.length > 0) {
    await setLocal({ gamification: state.gamification });
    if (settings.notificationsEnabled) notify(queue);
  }
}
