import { isInProgress } from '../progress';
import type { AnyProgress, Paper, Task } from '../types';

/**
 * Loose ends: things started and quietly dropped.
 *
 * The blog this borrows from finds contacts you haven't replied to in two
 * weeks. The equivalent here is not people but half-finished work — a paper
 * abandoned at 40%, an article open for three weeks, a task that has outlived
 * whatever made it urgent. ADHD makes those accumulate invisibly: nothing in
 * the app ever nags about them, because they're not overdue, just stalled.
 *
 * Pure and thresholded, deliberately without an LLM: "untouched for 21 days"
 * is a fact, and a model asked to judge staleness would invent nuance that
 * isn't there. The model's job is only to phrase the list.
 */

/* Bookmarks are deliberately absent: BookmarkLink records only createdAt, and
   a speed-dial link is meant to sit there — age is not evidence of neglect. */
export type LooseEndKind = 'paper' | 'reading' | 'task';

export interface LooseEnd {
  kind: LooseEndKind;
  /** What to show the user */
  label: string;
  /** Whole days since it was last touched */
  staleDays: number;
  /** Where to resume, '' when there is nowhere to go */
  url: string;
}

const DAY_MS = 86_400_000;

/** Days each kind may sit untouched before it counts as dropped. */
export const STALE_DAYS = {
  paper: 21,
  reading: 14,
  task: 30,
} as const;

/** Most items surfaced at once — a list of thirty is another thing to avoid. */
export const MAX_LOOSE_ENDS = 8;

export interface LooseEndsData {
  papers: Paper[];
  readingProgress: Record<string, AnyProgress>;
  tasks: Task[];
}

function daysSince(at: number, now: number): number {
  return Math.floor((now - at) / DAY_MS);
}

/**
 * Everything stalled, worst first. Ties break toward the more-progressed item:
 * a paper at 80% is a better thing to be reminded of than one at 5%.
 */
export function findLooseEnds(data: LooseEndsData, now = Date.now()): LooseEnd[] {
  const found: LooseEnd[] = [];

  for (const paper of data.papers) {
    if (paper.status !== 'reading') continue;
    const touched = paper.lastReadAt ?? paper.updatedAt;
    const staleDays = daysSince(touched, now);
    if (staleDays < STALE_DAYS.paper) continue;
    found.push({
      kind: 'paper',
      label: `“${paper.title}” — stopped at ${paper.progressPercent}%${paper.leftOff ? ` (${paper.leftOff})` : ''}`,
      staleDays,
      url: paper.url,
    });
  }

  for (const progress of Object.values(data.readingProgress)) {
    if (!isInProgress(progress)) continue;
    const staleDays = daysSince(progress.updatedAt, now);
    if (staleDays < STALE_DAYS.reading) continue;
    found.push({
      kind: 'reading',
      label: `“${progress.title || progress.url}” — ${progress.maxPercent}% in`,
      staleDays,
      url: progress.url,
    });
  }

  for (const task of data.tasks) {
    if (task.completedAt !== null) continue;
    const staleDays = daysSince(task.createdAt, now);
    if (staleDays < STALE_DAYS.task) continue;
    found.push({
      kind: 'task',
      label: `“${task.text}” — on the list ${staleDays} days`,
      staleDays,
      url: '',
    });
  }

  return found.sort((a, b) => b.staleDays - a.staleDays).slice(0, MAX_LOOSE_ENDS);
}

/** One line per loose end, for a prompt or a tool reply. */
export function formatLooseEnds(ends: LooseEnd[]): string {
  if (ends.length === 0) return 'Nothing stalled — everything you started is either done or recent.';
  return ends.map((e) => `- [${e.kind}] ${e.label} (${e.staleDays}d)`).join('\n');
}
