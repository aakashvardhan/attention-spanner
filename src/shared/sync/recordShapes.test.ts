import { describe, expect, it } from 'vitest';
import { START_EASE } from '../srs';
import { newFlashNoteWithCards, newPaper, newTask } from './recordShapes';

/**
 * These shapes are the contract between the extension's writers and the
 * WhatsApp bridge (functions/ compiles this same module) — assert the exact
 * fields so remote-created records stay merge-compatible.
 */

describe('newTask', () => {
  it('produces the full task shape with updatedAt stamped', () => {
    expect(newTask('  Buy milk ', 1000, 'id-1', 'capture')).toEqual({
      id: 'id-1',
      text: 'Buy milk',
      createdAt: 1000,
      completedAt: null,
      snoozedUntil: null,
      source: 'capture',
      updatedAt: 1000,
    });
  });
});

describe('newFlashNoteWithCards', () => {
  it('derives the cards alongside the note (a note alone is invisible)', () => {
    const { note, cards } = newFlashNoteWithCards({
      id: 'n1',
      deckId: 'd1',
      front: 'Q',
      back: 'A',
      now: 1000,
    });
    expect(note).toEqual({
      id: 'n1',
      deckId: 'd1',
      type: 'basic',
      front: 'Q',
      back: 'A',
      reversed: false,
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: 'n1#0',
      noteId: 'n1',
      deckId: 'd1',
      variant: 0,
      phase: 'new',
      stepIndex: 0,
      ease: START_EASE,
      intervalDays: 0,
      dueAt: 1000,
      lapses: 0,
      reps: 0,
      createdAt: 1000,
    });
  });

  it('reversed basic notes get both card variants', () => {
    const { cards } = newFlashNoteWithCards({
      id: 'n2',
      deckId: 'd1',
      front: 'Q',
      back: 'A',
      reversed: true,
      now: 1000,
    });
    expect(cards.map((c) => c.id)).toEqual(['n2#0', 'n2#1']);
  });
});

describe('newPaper', () => {
  it('stamps ids/timestamps onto the draft', () => {
    const paper = newPaper(
      {
        deckId: 'd1',
        title: 'Attention Is All You Need',
        authors: '',
        venue: '',
        year: null,
        citations: null,
        url: 'https://arxiv.org/abs/1706.03762',
        abstract: '',
        relevance: '',
        status: 'to-read',
        progressPercent: 0,
        leftOff: '',
      },
      1000,
      'p1',
    );
    expect(paper.id).toBe('p1');
    expect(paper.addedAt).toBe(1000);
    expect(paper.updatedAt).toBe(1000);
    expect(paper.lastReadAt).toBeNull();
  });
});
