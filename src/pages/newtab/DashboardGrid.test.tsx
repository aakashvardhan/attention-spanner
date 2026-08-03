import { describe, expect, it } from 'vitest';
import type { DashCard } from './DashboardGrid';
import { cardsForDashboardMode, cardsIntoColumns } from './DashboardGrid';

const Component = () => <div />;
const cards: DashCard[] = [
  'feeds',
  'dayplan',
  'agenda',
  'inbox',
  'links',
  'tasks',
  'continue',
  'streak',
  'gym',
  'braindump',
  'flashcards',
  'papers',
  'recordings',
  'warmup',
].map((id) => ({ id: id as DashCard['id'], title: id, Component }));

describe('cardsForDashboardMode', () => {
  it('keeps Focused in a stable semantic order', () => {
    const result = cardsForDashboardMode('focused', cards, new Set());
    expect(result.primary.map((card) => card.id)).toEqual([
      'dayplan',
      'agenda',
      'tasks',
      'continue',
      'streak',
    ]);
  });

  it('moves research tools above the fold without duplicating them', () => {
    const result = cardsForDashboardMode('research', cards, new Set());
    expect(result.primary.map((card) => card.id)).toEqual([
      'continue',
      'feeds',
      'papers',
      'recordings',
      'flashcards',
      'tasks',
    ]);
    expect(result.library.some((card) => card.id === 'feeds')).toBe(false);
  });

  it('omits unavailable integrations from both sections', () => {
    const result = cardsForDashboardMode('balanced', cards, new Set(['agenda', 'inbox']));
    expect([...result.primary, ...result.library].map((card) => card.id)).not.toContain('agenda');
    expect([...result.primary, ...result.library].map((card) => card.id)).not.toContain('inbox');
  });
});

describe('cardsIntoColumns', () => {
  it('distributes cards into stable independent stacks', () => {
    expect(cardsIntoColumns(cards.slice(0, 7), 3).map((column) => column.map((card) => card.id)))
      .toEqual([
        ['feeds', 'inbox', 'continue'],
        ['dayplan', 'links'],
        ['agenda', 'tasks'],
      ]);
  });
});
