import { sendMessage } from '../../messages';
import { resolveFlashDeckId, type Connector } from './base';

export const flashcardsConnector: Connector = {
  id: 'flashcards',
  label: 'Flashcards',
  isAvailable: () => true,
  tools: [
    {
      name: 'create_flashcard',
      description: 'Create a basic front/back flashcard for spaced-repetition study.',
      params: {
        type: 'object',
        required: ['front', 'back'],
        additionalProperties: false,
        properties: {
          front: { type: 'string', description: 'Question / front of the card', maxLength: 500 },
          back: { type: 'string', description: 'Answer / back of the card', maxLength: 500 },
          deck: { type: 'string', description: 'Deck name to add to (optional)', maxLength: 100 },
        },
      },
      confirm: true,
      summary: (p) => `Create flashcard “${p.front as string}”`,
      run: async (p) => {
        const deckId = await resolveFlashDeckId(p.deck as string | undefined);
        const res = await sendMessage({
          type: 'FLASH_ADD_NOTE',
          deckId,
          noteType: 'basic',
          front: p.front as string,
          back: p.back as string,
          reversed: false,
        });
        if (!res.ok) throw new Error(res.error ?? 'Could not create the card');
        return `Flashcard created: “${p.front as string}”.`;
      },
    },
    {
      name: 'save_flashcards',
      description:
        'Save several front/back flashcards at once (used after generating cards from a page).',
      params: {
        type: 'object',
        required: ['cards'],
        additionalProperties: false,
        properties: {
          cards: {
            type: 'array',
            description: 'The cards to save',
            items: {
              type: 'object',
              required: ['front', 'back'],
              properties: {
                front: { type: 'string', maxLength: 500 },
                back: { type: 'string', maxLength: 500 },
              },
            },
          },
          deck: { type: 'string', description: 'Deck name to add to (optional)', maxLength: 100 },
        },
      },
      confirm: true,
      summary: (p) => {
        const n = Array.isArray(p.cards) ? p.cards.length : 0;
        return `Save ${n} flashcard${n === 1 ? '' : 's'}`;
      },
      run: async (p) => {
        const cards = (Array.isArray(p.cards) ? p.cards : []).filter(
          (c): c is { front: string; back: string } =>
            typeof c === 'object' &&
            c !== null &&
            typeof (c as { front?: unknown }).front === 'string' &&
            typeof (c as { back?: unknown }).back === 'string',
        );
        if (cards.length === 0) throw new Error('No usable cards to save.');
        const deckId = await resolveFlashDeckId(p.deck as string | undefined);
        let saved = 0;
        for (const card of cards.slice(0, 12)) {
          const res = await sendMessage({
            type: 'FLASH_ADD_NOTE',
            deckId,
            noteType: 'basic',
            front: card.front.slice(0, 500),
            back: card.back.slice(0, 500),
            reversed: false,
          });
          if (res.ok) saved += 1;
        }
        if (saved === 0) throw new Error('Could not save the cards.');
        return `Saved ${saved} flashcard${saved === 1 ? '' : 's'}.`;
      },
    },
  ],
};
