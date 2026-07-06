import {
  MAX_DECKS,
  MAX_FLASH_NOTES,
  MAX_FLASHCARDS,
  SRS_DAILY_RETENTION_DAYS,
} from '../shared/constants';
import { localDate } from '../shared/format';
import { answerCard as scheduleAnswer, isRewardableAnswer, newCard, reconcileCards } from '../shared/srs';
import { getLocal, setLocal } from '../shared/storage';
import type { Deck, FlashNote, FlashNoteType, Rating, SrsDayStats } from '../shared/types';
import { awardXp } from './gamification';

/**
 * All flashcard writes happen here in the service worker so the flashcards
 * page, popup, and dashboard never race each other.
 */

export type FlashResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

export async function addDeck(name: string): Promise<FlashResult<{ deck: Deck }>> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'Deck name is required.' };
  const { decks } = await getLocal('decks');
  if (decks.length >= MAX_DECKS) return { ok: false, error: `Deck limit reached (${MAX_DECKS}).` };
  if (decks.some((d) => d.name === trimmed)) return { ok: false, error: 'A deck with that name exists.' };
  const deck: Deck = { id: crypto.randomUUID(), name: trimmed, createdAt: Date.now() };
  await setLocal({ decks: [...decks, deck] });
  return { ok: true, deck };
}

export async function renameDeck(id: string, name: string): Promise<FlashResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'Deck name is required.' };
  const { decks } = await getLocal('decks');
  const deck = decks.find((d) => d.id === id);
  if (!deck) return { ok: false, error: 'Deck not found.' };
  deck.name = trimmed;
  await setLocal({ decks });
  return { ok: true };
}

export async function deleteDeck(id: string): Promise<FlashResult> {
  const { decks, flashNotes, flashCards } = await getLocal('decks', 'flashNotes', 'flashCards');
  await setLocal({
    decks: decks.filter((d) => d.id !== id),
    flashNotes: flashNotes.filter((n) => n.deckId !== id),
    flashCards: flashCards.filter((c) => c.deckId !== id),
    // srsDaily history intentionally kept — the chart just shows fewer decks
  });
  return { ok: true };
}

export async function addNote(
  deckId: string,
  noteType: FlashNoteType,
  front: string,
  back: string,
  reversed: boolean,
): Promise<FlashResult<{ note: FlashNote }>> {
  const now = Date.now();
  const note: FlashNote = {
    id: crypto.randomUUID(),
    deckId,
    type: noteType,
    front: front.trim(),
    back: back.trim(),
    reversed: noteType === 'basic' && reversed,
    createdAt: now,
    updatedAt: now,
  };
  const cards = reconcileCards(note, [], now);
  const error = await validateNote(note, cards.length, null);
  if (error) return { ok: false, error };

  const { flashNotes, flashCards } = await getLocal('flashNotes', 'flashCards');
  if (flashNotes.length >= MAX_FLASH_NOTES)
    return { ok: false, error: `Note limit reached (${MAX_FLASH_NOTES}).` };
  if (flashCards.length + cards.length > MAX_FLASHCARDS)
    return { ok: false, error: `Card limit reached (${MAX_FLASHCARDS}).` };
  await setLocal({ flashNotes: [...flashNotes, note], flashCards: [...flashCards, ...cards] });
  return { ok: true, note };
}

export async function updateNote(
  id: string,
  patch: { front: string; back: string; reversed: boolean },
): Promise<FlashResult> {
  const now = Date.now();
  const { flashNotes, flashCards } = await getLocal('flashNotes', 'flashCards');
  const note = flashNotes.find((n) => n.id === id);
  if (!note) return { ok: false, error: 'Note not found.' };

  const updated: FlashNote = {
    ...note,
    front: patch.front.trim(),
    back: patch.back.trim(),
    reversed: note.type === 'basic' && patch.reversed,
    updatedAt: now,
  };
  const existing = flashCards.filter((c) => c.noteId === id);
  const reconciled = reconcileCards(updated, existing, now);
  const error = await validateNote(updated, reconciled.length, existing.length);
  if (error) return { ok: false, error };
  if (flashCards.length - existing.length + reconciled.length > MAX_FLASHCARDS)
    return { ok: false, error: `Card limit reached (${MAX_FLASHCARDS}).` };

  await setLocal({
    flashNotes: flashNotes.map((n) => (n.id === id ? updated : n)),
    flashCards: [...flashCards.filter((c) => c.noteId !== id), ...reconciled],
  });
  return { ok: true };
}

async function validateNote(
  note: FlashNote,
  cardCount: number,
  _existingCount: number | null,
): Promise<string | null> {
  if (!note.front) return 'Front text is required.';
  if (note.type === 'cloze' && cardCount === 0)
    return 'Cloze notes need at least one {{c1::...}} deletion.';
  if (note.type === 'basic' && !note.back) return 'Back text is required.';
  return null;
}

export async function deleteNote(id: string): Promise<FlashResult> {
  const { flashNotes, flashCards } = await getLocal('flashNotes', 'flashCards');
  await setLocal({
    flashNotes: flashNotes.filter((n) => n.id !== id),
    flashCards: flashCards.filter((c) => c.noteId !== id),
  });
  return { ok: true };
}

export async function answerCard(cardId: string, rating: Rating): Promise<FlashResult> {
  const now = Date.now();
  const { flashCards, srsDaily } = await getLocal('flashCards', 'srsDaily');
  const card = flashCards.find((c) => c.id === cardId);
  if (!card) return { ok: false, error: 'Card not found.' };

  const prevPhase = card.phase;
  const next = scheduleAnswer(card, rating, now);

  const today = localDate();
  const day: SrsDayStats = (srsDaily[today] ??= { reviews: {}, newIntroduced: {} });
  day.reviews[card.deckId] = (day.reviews[card.deckId] ?? 0) + 1;
  if (prevPhase === 'new') {
    day.newIntroduced[card.deckId] = (day.newIntroduced[card.deckId] ?? 0) + 1;
  }
  pruneSrsDaily(srsDaily, now);

  await setLocal({
    flashCards: flashCards.map((c) => (c.id === cardId ? next : c)),
    srsDaily,
  });

  // XP only for scheduled reviews and first graduations — non-farmable
  if (isRewardableAnswer(prevPhase, next)) {
    await awardXp('flashcard_review');
  }
  return { ok: true };
}

/** Back to a pristine new card (browse-table action) */
export async function resetCard(cardId: string): Promise<FlashResult> {
  const { flashCards } = await getLocal('flashCards');
  const card = flashCards.find((c) => c.id === cardId);
  if (!card) return { ok: false, error: 'Card not found.' };
  const pristine = { ...newCard(card.noteId, card.deckId, card.variant, Date.now()), createdAt: card.createdAt };
  await setLocal({ flashCards: flashCards.map((c) => (c.id === cardId ? pristine : c)) });
  return { ok: true };
}

function pruneSrsDaily(srsDaily: Record<string, SrsDayStats>, now: number): void {
  const cutoff = localDate(new Date(now - SRS_DAILY_RETENTION_DAYS * 86_400_000));
  for (const key of Object.keys(srsDaily)) {
    if (key < cutoff) delete srsDaily[key];
  }
}
