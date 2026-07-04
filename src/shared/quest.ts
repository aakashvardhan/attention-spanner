import type { DayStats, Settings } from './types';
import { countInWeek, weekDates, weekKey } from './week';

/**
 * Weekly quest — derived entirely from existing data (gym check-ins +
 * streaks.daily); nothing stored except celebration bookkeeping.
 */

export interface QuestLine {
  key: 'gym' | 'articles' | 'sprints' | 'videos' | 'focus';
  emoji: string;
  label: string;
  current: number;
  target: number;
}

export interface QuestProgress {
  lines: QuestLine[];
  complete: boolean;
}

export function questProgress(
  checkins: Record<string, number>,
  daily: Record<string, DayStats>,
  settings: Pick<
    Settings,
    | 'gymWeeklyTarget'
    | 'questArticlesPerWeek'
    | 'questSprintsPerWeek'
    | 'questVideosPerWeek'
    | 'questFocusPerWeek'
  >,
  week = weekKey(),
): QuestProgress {
  const dates = weekDates(week);
  const sum = (pick: (d: DayStats) => number) =>
    dates.reduce((total, date) => total + (daily[date] ? pick(daily[date]) : 0), 0);

  const all: QuestLine[] = [
    {
      key: 'gym',
      emoji: '💪',
      label: 'Gym',
      current: countInWeek(checkins, week),
      target: settings.gymWeeklyTarget,
    },
    {
      key: 'articles',
      emoji: '📖',
      label: 'Articles',
      current: sum((d) => d.articlesFinished),
      target: settings.questArticlesPerWeek,
    },
    {
      key: 'sprints',
      emoji: '⏱️',
      label: 'Sprints',
      current: sum((d) => d.sprints),
      target: settings.questSprintsPerWeek,
    },
    {
      key: 'videos',
      emoji: '🎬',
      label: 'Videos',
      current: sum((d) => d.videosFinished ?? 0),
      target: settings.questVideosPerWeek,
    },
    {
      key: 'focus',
      emoji: '🎯',
      label: 'Focus blocks',
      current: sum((d) => d.focusBlocks ?? 0),
      target: settings.questFocusPerWeek,
    },
  ];

  const lines = all.filter((line) => line.target > 0);
  return {
    lines,
    complete: lines.length > 0 && lines.every((line) => line.current >= line.target),
  };
}
