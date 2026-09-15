import type { Paper, PaperDraft, Task } from './types';

/**
 * The id-addressable, user-authored collections, and the factories that build
 * their records. One source of truth for record shapes; pure, so callers pass
 * now/ids.
 *
 * This list outlived cloud sync, which is where it started: agentRuns.ts uses
 * it as the whitelist of collections an agent proposal is allowed to touch.
 */

export const RECORD_COLLECTIONS = [
  'tasks',
  'notes',
  'bookmarks',
  'bookmarkGroups',
  'decks',
  'papers',
  'jobs',
] as const;

export type RecordCollection = (typeof RECORD_COLLECTIONS)[number];

export function newTask(
  text: string,
  now: number,
  id: string,
  source: Task['source'] = 'capture',
): Task {
  return {
    id,
    text: text.trim(),
    createdAt: now,
    completedAt: null,
    snoozedUntil: null,
    source,
    updatedAt: now,
  };
}

export function newPaper(draft: PaperDraft, now: number, id: string): Paper {
  return {
    ...draft,
    id,
    addedAt: now,
    updatedAt: now,
    lastReadAt: draft.status === 'reading' ? now : null,
  };
}
