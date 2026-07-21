import { reconcileCards } from '../srs';
import type { FlashCard, FlashNote, FlashNoteType, Paper, PaperDraft, Task } from '../types';

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

/**
 * A note is invisible without its cards: the extension derives FlashCard rows
 * only at write time (nothing regenerates cards from synced notes), so every
 * writer must persist the note AND its derived cards together.
 */
export function newFlashNoteWithCards(args: {
  id: string;
  deckId: string;
  type?: FlashNoteType;
  front: string;
  back: string;
  reversed?: boolean;
  now: number;
}): { note: FlashNote; cards: FlashCard[] } {
  const type = args.type ?? 'basic';
  const note: FlashNote = {
    id: args.id,
    deckId: args.deckId,
    type,
    front: args.front.trim(),
    back: args.back.trim(),
    reversed: type === 'basic' && (args.reversed ?? false),
    createdAt: args.now,
    updatedAt: args.now,
  };
  return { note, cards: reconcileCards(note, [], args.now) };
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
