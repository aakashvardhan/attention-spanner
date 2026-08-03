import { describe, expect, it } from 'vitest';
import { newPaper, newTask } from './records';

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
