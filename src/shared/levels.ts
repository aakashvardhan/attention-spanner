/**
 * XP economy + level curve. Each level costs 100 XP more than the last:
 * L1→L2 = 100, L2→L3 = 200, … cumulative threshold xpForLevel(n) = 50·n·(n−1)
 * → L2 @ 100, L3 @ 300, L5 @ 1000, L10 @ 4500.
 */

export type XpEvent =
  | 'gym_checkin'
  | 'article_finished'
  | 'video_finished'
  | 'sprint_completed'
  | 'task_completed'
  | 'braindump_structured'
  | 'focus_block'
  | 'flashcard_review'
  | 'warmup_complete';

export const XP_VALUES: Record<XpEvent, number> = {
  focus_block: 25,
  gym_checkin: 20,
  article_finished: 15,
  video_finished: 15,
  sprint_completed: 10,
  warmup_complete: 10,
  task_completed: 5,
  braindump_structured: 5,
  flashcard_review: 5,
};

export const QUEST_XP_BONUS = 50;

/** Total XP required to reach `level` (level 1 = 0 XP) */
export function xpForLevel(level: number): number {
  return 50 * level * (level - 1);
}

export function levelForXp(xp: number): { level: number; intoLevel: number; toNext: number } {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level += 1;
  const floor = xpForLevel(level);
  return {
    level,
    intoLevel: xp - floor,
    toNext: xpForLevel(level + 1) - floor,
  };
}
