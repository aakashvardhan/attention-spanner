/**
 * Badge catalog — pure data + predicates over a stats snapshot.
 * Badges unlock once and are never revoked.
 */

export interface StatsSnapshot {
  articlesFinished: number;
  videosFinished: number;
  readingStreak: number;
  sprints: number;
  tasksCompleted: number;
  brainDumps: number;
  focusBlocks: number;
  freezesEarned: number;
}

export interface Badge {
  id: string;
  title: string;
  description: string;
  earned: (s: StatsSnapshot) => boolean;
}

export const BADGES: readonly Badge[] = [
  { id: 'first-article', title: 'Finisher', description: 'Finish reading your first article', earned: (s) => s.articlesFinished >= 1 },
  { id: 'articles-10', title: 'Ten Down', description: 'Finish 10 articles', earned: (s) => s.articlesFinished >= 10 },
  { id: 'articles-50', title: 'Well Read', description: 'Finish 50 articles', earned: (s) => s.articlesFinished >= 50 },
  { id: 'first-video', title: 'Press Play', description: 'Finish your first long video', earned: (s) => s.videosFinished >= 1 },
  { id: 'videos-10', title: 'Binge Learner', description: 'Finish 10 long videos', earned: (s) => s.videosFinished >= 10 },
  { id: 'videos-50', title: 'Lecture Hall', description: 'Finish 50 long videos', earned: (s) => s.videosFinished >= 50 },
  { id: 'read-streak-7', title: 'Week of Focus', description: 'A 7-day reading streak', earned: (s) => s.readingStreak >= 7 },
  { id: 'read-streak-30', title: 'Thirty-Day Flame', description: 'A 30-day reading streak', earned: (s) => s.readingStreak >= 30 },
  { id: 'sprints-25', title: 'Sprinter', description: 'Complete 25 reading sprints', earned: (s) => s.sprints >= 25 },
  { id: 'sprints-100', title: 'Century Sprints', description: 'Complete 100 reading sprints', earned: (s) => s.sprints >= 100 },
  { id: 'first-focus', title: 'Locked In', description: 'Complete your first focus block', earned: (s) => s.focusBlocks >= 1 },
  { id: 'focus-25', title: 'Distraction Slayer', description: 'Complete 25 focus blocks', earned: (s) => s.focusBlocks >= 25 },
  { id: 'focus-100', title: 'Deep Work', description: 'Complete 100 focus blocks', earned: (s) => s.focusBlocks >= 100 },
  { id: 'tasks-50', title: 'Task Slayer', description: 'Complete 50 tasks', earned: (s) => s.tasksCompleted >= 50 },
  { id: 'dumps-10', title: 'Mind Gardener', description: 'Structure 10 brain dumps', earned: (s) => s.brainDumps >= 10 },
  { id: 'freezes-10', title: 'Lucky Streak', description: 'Bank 10 streak freezes', earned: (s) => (s.freezesEarned ?? 0) >= 10 },
];
