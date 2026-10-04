import { describe, expect, it } from 'vitest';
import type { Deck, Paper } from '../types';
import { intakeQuestions, readIntake } from './intake';

const deck = (id: string, name: string) => ({ id, name, kind: 'papers' }) as Deck;
const paper = (deckId: string, title: string) => ({ deckId, title }) as Paper;
const decks = [deck('d1', 'Generative models'), deck('d2', 'Systems')];

describe('intakeQuestions', () => {
  it('describes each deck by the papers already in it', () => {
    const q = intakeQuestions(decks, [paper('d1', 'GANs'), paper('d1', 'VAEs'), paper('d1', 'Third')]);
    expect(q.deck).toMatchObject({ type: 'choice', criteria: { 'Generative models': 'e.g. GANs; VAEs', Systems: null } });
  });

  it('does not ask for a deck when there is only one', () => {
    expect(intakeQuestions([decks[0]], []).deck).toBeUndefined();
  });
});

describe('readIntake', () => {
  it('maps a confident deck name back to its id', () => {
    const answers = {
      deck: { type: 'choice' as const, choice: 'Generative models', probabilities: { 'Generative models': 0.62, Systems: 0.38 } },
      kind: { type: 'choice' as const, choice: 'method', probabilities: { method: 0.9 } },
    };
    expect(readIntake(answers, decks, 0.55)).toEqual({ deckId: 'd1', kind: 'method' });
  });

  it('suggests nothing for a paper Laya cannot place', () => {
    // DDPM in practice: method 0.50 vs theory 0.44
    const answers = { kind: { type: 'choice' as const, choice: 'method', probabilities: { method: 0.5, theory: 0.44 } } };
    expect(readIntake(answers, decks, 0.55)).toEqual({ deckId: null, kind: null });
  });
});
