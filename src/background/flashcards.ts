import { MAX_DECKS } from '../shared/constants';
import { getLocal, setLocal } from '../shared/storage';
import type { Deck, DeckKind } from '../shared/types';

/**
 * Deck writes, serialized in the service worker so the papers page and the
 * reader never race each other.
 *
 * The FLASH_ prefix on the messages is a leftover: decks were introduced for
 * flashcards, and Papers borrowed them as its own container (kind: 'papers').
 * When the flashcards feature was cut the decks stayed, because papers live in
 * them. Renaming the messages would touch every caller for no behaviour change.
 */

export type FlashResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

export async function addDeck(
  name: string,
  kind: DeckKind = 'flashcards',
): Promise<FlashResult<{ deck: Deck }>> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'Deck name is required.' };
  const { decks } = await getLocal('decks');
  if (decks.length >= MAX_DECKS) return { ok: false, error: `Deck limit reached (${MAX_DECKS}).` };
  // Names must be unique within a kind — a flashcard deck and a paper deck may
  // share a name.
  if (decks.some((d) => d.kind === kind && d.name === trimmed)) {
    return { ok: false, error: 'A deck with that name exists.' };
  }
  const deck: Deck = { id: crypto.randomUUID(), name: trimmed, createdAt: Date.now(), kind };
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
  const { decks, papers } = await getLocal('decks', 'papers');
  await setLocal({
    decks: decks.filter((d) => d.id !== id),
    // Papers live in decks, so they cascade with the deck
    papers: papers.filter((p) => p.deckId !== id),
  });
  return { ok: true };
}
