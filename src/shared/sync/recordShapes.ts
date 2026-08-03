import type { Paper, PaperDraft, Task } from '../types';

/**
 * Record factories shared by every writer of synced collections: the
 * extension's background modules AND the WhatsApp bridge (functions/ includes
 * this file). One source of truth for record shapes and SRS defaults — a
 * record created remotely must be byte-compatible with one created locally,
 * or the merge layer's expectations drift. Pure: callers pass now/ids.
 */

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
