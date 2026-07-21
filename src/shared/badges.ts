/**
 * Badge catalog — pure data + predicates over a stats snapshot.
 * Badges unlock once and are never revoked.
 */

export interface StatsSnapshot {
  workouts: number;
  gymWeekStreak: number;
  articlesFinished: number;
  videosFinished: number;
  readingStreak: number;
  sprints: number;
  tasksCompleted: number;
  brainDumps: number;
  focusBlocks: number;
  cardsReviewed: number;
  chestsOpened: number;
  warmups: number;
  level: number;
}

export interface Badge {
  id: string;
  emoji: string;
  title: string;
  description: string;
  earned: (s: StatsSnapshot) => boolean;
}

export const BADGES: readonly Badge[] = [
  { id: 'first-workout', emoji: '💪', title: 'First Rep', description: 'Log your first workout', earned: (s) => s.workouts >= 1 },
  { id: 'gym-10', emoji: '🏋️', title: 'Regular', description: 'Log 10 workouts', earned: (s) => s.workouts >= 10 },
  { id: 'gym-50', emoji: '🦾', title: 'Iron Habit', description: 'Log 50 workouts', earned: (s) => s.workouts >= 50 },
  { id: 'gym-streak-4', emoji: '📆', title: 'Four-Week Club', description: 'Hit your gym goal 4 weeks in a row', earned: (s) => s.gymWeekStreak >= 4 },
  { id: 'gym-streak-12', emoji: '🗓️', title: 'Quarter Machine', description: 'Hit your gym goal 12 weeks in a row', earned: (s) => s.gymWeekStreak >= 12 },
  { id: 'first-article', emoji: '📖', title: 'Finisher', description: 'Finish reading your first article', earned: (s) => s.articlesFinished >= 1 },
  { id: 'articles-10', emoji: '📚', title: 'Ten Down', description: 'Finish 10 articles', earned: (s) => s.articlesFinished >= 10 },
  { id: 'articles-50', emoji: '🏛️', title: 'Well Read', description: 'Finish 50 articles', earned: (s) => s.articlesFinished >= 50 },
  { id: 'first-video', emoji: '🎬', title: 'Press Play', description: 'Finish your first long video', earned: (s) => s.videosFinished >= 1 },
  { id: 'videos-10', emoji: '📺', title: 'Binge Learner', description: 'Finish 10 long videos', earned: (s) => s.videosFinished >= 10 },
  { id: 'videos-50', emoji: '🎓', title: 'Lecture Hall', description: 'Finish 50 long videos', earned: (s) => s.videosFinished >= 50 },
  { id: 'read-streak-7', emoji: '🔥', title: 'Week of Focus', description: 'A 7-day reading streak', earned: (s) => s.readingStreak >= 7 },
  { id: 'read-streak-30', emoji: '🌋', title: 'Thirty-Day Flame', description: 'A 30-day reading streak', earned: (s) => s.readingStreak >= 30 },
  { id: 'sprints-25', emoji: '⏱️', title: 'Sprinter', description: 'Complete 25 reading sprints', earned: (s) => s.sprints >= 25 },
  { id: 'sprints-100', emoji: '🚀', title: 'Century Sprints', description: 'Complete 100 reading sprints', earned: (s) => s.sprints >= 100 },
  { id: 'first-focus', emoji: '🎯', title: 'Locked In', description: 'Complete your first focus block', earned: (s) => s.focusBlocks >= 1 },
  { id: 'focus-25', emoji: '🛡️', title: 'Distraction Slayer', description: 'Complete 25 focus blocks', earned: (s) => s.focusBlocks >= 25 },
  { id: 'focus-100', emoji: '🏰', title: 'Deep Work', description: 'Complete 100 focus blocks', earned: (s) => s.focusBlocks >= 100 },
  { id: 'tasks-50', emoji: '✅', title: 'Task Slayer', description: 'Complete 50 tasks', earned: (s) => s.tasksCompleted >= 50 },
  { id: 'cards-100', emoji: '🃏', title: 'Century Recall', description: 'Review 100 flashcards', earned: (s) => s.cardsReviewed >= 100 },
  { id: 'dumps-10', emoji: '🧠', title: 'Mind Gardener', description: 'Structure 10 brain dumps', earned: (s) => s.brainDumps >= 10 },
  { id: 'chests-10', emoji: '🎁', title: 'Lucky Day', description: 'Open 10 mystery chests', earned: (s) => (s.chestsOpened ?? 0) >= 10 },
  { id: 'level-5', emoji: '⭐', title: 'Level 5', description: 'Reach level 5', earned: (s) => s.level >= 5 },
  { id: 'level-10', emoji: '🌟', title: 'Level 10', description: 'Reach level 10', earned: (s) => s.level >= 10 },
];
