import type { Paper, PaperDraft } from './types';

/**
 * Factories for the user-authored record shapes. Pure, so callers pass now/ids.
 */

export function newPaper(draft: PaperDraft, now: number, id: string): Paper {
  return {
    ...draft,
    id,
    addedAt: now,
    updatedAt: now,
    lastReadAt: draft.status === 'reading' ? now : null,
  };
}
