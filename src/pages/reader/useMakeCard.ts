import { useCallback } from 'react';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { sendMessage } from '../../shared/messages';

/** Deck that catches cards made while reading something untracked. */
export const READING_DECK_NAME = 'Reading';

/**
 * Turn a selection into a cloze card, filed in the document's deck.
 *
 * Highlights, decks and the SM-2 scheduler all existed independently; nothing
 * connected them, so reading never produced anything reviewable. This is that
 * connection: select a sentence, get a card, review it tomorrow.
 */
export function useMakeCard(): (text: string, sourceTitle: string, deckId?: string) => Promise<void> {
  const [decks] = useStorageValue('decks');

  return useCallback(
    async (text: string, sourceTitle: string, deckId?: string) => {
      const quote = text.replace(/\s+/g, ' ').trim();
      if (!quote) return;

      let targetId = deckId;
      if (!targetId) {
        const existing = decks.find(
          (d) => (d.kind ?? 'flashcards') === 'flashcards' && d.name === READING_DECK_NAME,
        );
        if (existing) targetId = existing.id;
        else {
          const made = await sendMessage({
            type: 'FLASH_ADD_DECK',
            name: READING_DECK_NAME,
            kind: 'flashcards',
          });
          if (!made.ok || !made.deck) return;
          targetId = made.deck.id;
        }
      }

      // Cloze over the whole selection: the user picked the span precisely
      // because it is the bit worth recalling.
      await sendMessage({
        type: 'FLASH_ADD_NOTE',
        deckId: targetId,
        noteType: 'cloze',
        front: `{{c1::${quote}}}`,
        back: sourceTitle,
        reversed: false,
      });
    },
    [decks],
  );
}
