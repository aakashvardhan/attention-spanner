import { rollChest } from '../shared/chests';
import { daysAgo, localDate } from '../shared/format';
import { getLocal, setLocal } from '../shared/storage';
import { awardChest, awardXp } from './gamification';

/**
 * Brain warm-up (Stroop sprint) — pre-work ritual. Replays are unlimited,
 * but only the first completion of a local day counts for the streak, XP,
 * and chest roll, so replays can't farm rewards.
 */

const WARMUP_WINDOW_DAYS = 365;

function pruneDays(days: Record<string, { score: number; accuracy: number }>): void {
  const cutoff = localDate(daysAgo(WARMUP_WINDOW_DAYS));
  for (const date of Object.keys(days)) {
    if (date < cutoff) delete days[date];
  }
}

export async function completeWarmup(
  score: number,
  total: number,
): Promise<{ ok: boolean; firstToday: boolean }> {
  // The SW is the trust boundary for XP-bearing input — clamp to plausible
  // 60-second-sprint numbers before recording anything
  const safeTotal = Math.max(0, Math.min(Math.floor(total), 300));
  const safeScore = Math.max(0, Math.min(Math.floor(score), safeTotal));
  const accuracy = safeTotal > 0 ? Math.round((safeScore / safeTotal) * 100) : 0;

  const { warmup } = await getLocal('warmup');
  const today = localDate();
  const firstToday = !(today in warmup.days);

  const prev = warmup.days[today];
  if (!prev || safeScore > prev.score) warmup.days[today] = { score: safeScore, accuracy };
  warmup.bestScore = Math.max(warmup.bestScore, safeScore);

  if (firstToday) {
    warmup.currentStreak =
      warmup.lastPlayedDate === localDate(daysAgo(1)) ? warmup.currentStreak + 1 : 1;
    warmup.lastPlayedDate = today;
    warmup.longestStreak = Math.max(warmup.longestStreak, warmup.currentStreak);
  }

  pruneDays(warmup.days);
  await setLocal({ warmup });

  if (firstToday) {
    await awardXp('warmup_complete');
    const bonus = rollChest();
    if (bonus !== null) await awardChest(bonus);
  }
  return { ok: true, firstToday };
}

/** On startup: break the streak once a full day has passed with no warm-up */
export async function recomputeWarmupStreak(): Promise<void> {
  const { warmup } = await getLocal('warmup');
  const today = localDate();
  const yesterday = localDate(daysAgo(1));
  if (
    warmup.currentStreak > 0 &&
    warmup.lastPlayedDate !== today &&
    warmup.lastPlayedDate !== yesterday
  ) {
    warmup.currentStreak = 0;
    await setLocal({ warmup });
  }
}
