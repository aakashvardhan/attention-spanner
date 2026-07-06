import { describe, expect, it } from 'vitest';
import {
  answerCard,
  buildQueue,
  cardsForNote,
  dueCounts,
  endOfLocalDay,
  formatInterval,
  isRewardableAnswer,
  MAX_INTERVAL_DAYS,
  newCard,
  NEW_PER_DAY,
  previewIntervals,
  reconcileCards,
} from './srs';
import type { FlashCard, FlashNote } from './types';

const MIN = 60_000;
const DAY = 86_400_000;
// Fixed local-noon reference so end-of-day math is stable in any timezone
const NOW = new Date(2026, 6, 5, 12, 0, 0).getTime();

const fresh = (over: Partial<FlashCard> = {}): FlashCard => ({
  ...newCard('n1', 'd1', 0, NOW),
  ...over,
});

const reviewCard = (intervalDays: number, ease = 2.5, over: Partial<FlashCard> = {}): FlashCard =>
  fresh({ phase: 'review', intervalDays, ease, dueAt: NOW, ...over });

describe('answerCard — learning', () => {
  it('new + Good enters step 1 (10m)', () => {
    const next = answerCard(fresh(), 'good', NOW);
    expect(next.phase).toBe('learning');
    expect(next.stepIndex).toBe(1);
    expect(next.dueAt).toBe(NOW + 10 * MIN);
    expect(next.reps).toBe(1);
  });

  it('Good past the last step graduates at 1d with ease untouched', () => {
    const learning = answerCard(fresh(), 'good', NOW);
    const next = answerCard(learning, 'good', NOW);
    expect(next.phase).toBe('review');
    expect(next.intervalDays).toBe(1);
    expect(next.dueAt).toBe(NOW + DAY);
    expect(next.ease).toBe(2.5);
  });

  it('new + Easy graduates immediately at 4d', () => {
    const next = answerCard(fresh(), 'easy', NOW);
    expect(next.phase).toBe('review');
    expect(next.intervalDays).toBe(4);
    expect(next.dueAt).toBe(NOW + 4 * DAY);
  });

  it('Again mid-learning resets to step 0 (1m)', () => {
    const learning = answerCard(fresh(), 'good', NOW);
    const next = answerCard(learning, 'again', NOW);
    expect(next.stepIndex).toBe(0);
    expect(next.dueAt).toBe(NOW + 1 * MIN);
    expect(next.lapses).toBe(0);
    expect(next.ease).toBe(2.5);
  });

  it('Hard repeats the current step', () => {
    const learning = answerCard(fresh(), 'good', NOW); // step 1 (10m)
    const next = answerCard(learning, 'hard', NOW);
    expect(next.stepIndex).toBe(1);
    expect(next.dueAt).toBe(NOW + 10 * MIN);
  });
});

describe('answerCard — review', () => {
  it('Good multiplies by ease', () => {
    const next = answerCard(reviewCard(10), 'good', NOW);
    expect(next.intervalDays).toBe(25);
    expect(next.dueAt).toBe(NOW + 25 * DAY);
    expect(next.ease).toBe(2.5);
  });

  it('Hard multiplies by 1.2 and drops ease 0.15', () => {
    const next = answerCard(reviewCard(10), 'hard', NOW);
    expect(next.intervalDays).toBe(12);
    expect(next.ease).toBe(2.35);
  });

  it('Easy multiplies by ease×1.3 and raises ease 0.15', () => {
    const next = answerCard(reviewCard(10), 'easy', NOW);
    expect(next.intervalDays).toBe(33); // round(10 × 2.5 × 1.3)
    expect(next.ease).toBe(2.65);
  });

  it('interval always grows by at least one day', () => {
    const next = answerCard(reviewCard(1), 'hard', NOW);
    expect(next.intervalDays).toBe(2); // max(1+1, round(1.2))
  });

  it('Again lapses: relearning at 10m, ease −0.20, lapse counted, next interval 1d', () => {
    const next = answerCard(reviewCard(20), 'again', NOW);
    expect(next.phase).toBe('relearning');
    expect(next.dueAt).toBe(NOW + 10 * MIN);
    expect(next.ease).toBe(2.3);
    expect(next.lapses).toBe(1);
    expect(next.intervalDays).toBe(1);
  });

  it('ease never drops below 1.30', () => {
    let card = reviewCard(10, 1.35);
    card = answerCard(card, 'hard', NOW);
    expect(card.ease).toBe(1.3);
    card = { ...card, phase: 'review' };
    card = answerCard(card, 'again', NOW);
    expect(card.ease).toBe(1.3);
  });

  it('interval is capped', () => {
    const next = answerCard(reviewCard(30000), 'easy', NOW);
    expect(next.intervalDays).toBe(MAX_INTERVAL_DAYS);
  });
});

describe('answerCard — relearning', () => {
  const lapsed = answerCard(reviewCard(20), 'again', NOW);

  it('Good graduates back to review at the stored 1d interval', () => {
    const next = answerCard(lapsed, 'good', NOW);
    expect(next.phase).toBe('review');
    expect(next.intervalDays).toBe(1);
    expect(next.dueAt).toBe(NOW + DAY);
  });

  it('Again resets the step without a second ease penalty', () => {
    const next = answerCard(lapsed, 'again', NOW);
    expect(next.phase).toBe('relearning');
    expect(next.ease).toBe(2.3);
    expect(next.lapses).toBe(1);
    expect(next.dueAt).toBe(NOW + 10 * MIN);
  });

  it('Easy exits relearning immediately', () => {
    const next = answerCard(lapsed, 'easy', NOW);
    expect(next.phase).toBe('review');
    expect(next.intervalDays).toBe(1);
  });
});

describe('previewIntervals', () => {
  it('labels a new card 1m / 10m / 10m→wait, per spec: again 1m, hard 1m, good 10m, easy 4d', () => {
    const labels = previewIntervals(fresh(), NOW);
    expect(labels.again).toBe('1m');
    expect(labels.hard).toBe('1m'); // repeats step 0
    expect(labels.good).toBe('10m');
    expect(labels.easy).toBe('4d');
  });

  it('matches answerCard for a review card', () => {
    const labels = previewIntervals(reviewCard(10), NOW);
    expect(labels.again).toBe('10m');
    expect(labels.hard).toBe('12d');
    expect(labels.good).toBe('25d');
    expect(labels.easy).toBe('1.1mo'); // 33d crosses the month display threshold
  });

  it('formats months and years', () => {
    expect(formatInterval(90 * DAY)).toBe('3mo');
    expect(formatInterval(548 * DAY)).toBe('1.5yr');
    expect(formatInterval(DAY)).toBe('1d');
  });
});

describe('cardsForNote / reconcileCards', () => {
  const note = (over: Partial<FlashNote> = {}): FlashNote => ({
    id: 'n1',
    deckId: 'd1',
    type: 'basic',
    front: 'F',
    back: 'B',
    reversed: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });

  it('basic → [0]; reversed → [0, 1]; cloze → its indexes', () => {
    expect(cardsForNote(note())).toEqual([0]);
    expect(cardsForNote(note({ reversed: true }))).toEqual([0, 1]);
    expect(cardsForNote(note({ type: 'cloze', front: '{{c2::b}} {{c1::a}}' }))).toEqual([1, 2]);
  });

  it('keeps scheduling for surviving variants, creates new, drops removed', () => {
    const n = note({ type: 'cloze', front: '{{c1::a}} {{c2::b}}' });
    const scheduled = { ...newCard('n1', 'd1', 1, NOW - DAY), phase: 'review' as const, intervalDays: 9 };
    const doomed = newCard('n1', 'd1', 3, NOW - DAY);
    const out = reconcileCards(n, [scheduled, doomed], NOW);
    expect(out.map((c) => c.variant)).toEqual([1, 2]);
    expect(out[0]).toBe(scheduled); // untouched object, scheduling preserved
    expect(out[1].phase).toBe('new');
    expect(out[1].createdAt).toBe(NOW);
  });
});

describe('buildQueue / dueCounts', () => {
  it('orders learning-due, then new (capped), then review-due', () => {
    const learning = fresh({ id: 'l', phase: 'learning', dueAt: NOW - MIN });
    const review = fresh({ id: 'r', phase: 'review', intervalDays: 3, dueAt: NOW + MIN });
    const brandNew = fresh({ id: 'n' });
    const queue = buildQueue([review, brandNew, learning], 'd1', NOW, 0);
    expect(queue.map((c) => c.id)).toEqual(['l', 'n', 'r']);
  });

  it('respects the daily new limit', () => {
    const cards = Array.from({ length: 30 }, (_, i) =>
      fresh({ id: `n${i}`, variant: i, createdAt: NOW + i }),
    );
    expect(buildQueue(cards, 'd1', NOW, 0)).toHaveLength(NEW_PER_DAY);
    expect(buildQueue(cards, 'd1', NOW, 18)).toHaveLength(2);
    expect(buildQueue(cards, 'd1', NOW, 25)).toHaveLength(0);
  });

  it('serves learn-ahead cards only when nothing else is due', () => {
    const soon = fresh({ id: 's', phase: 'learning', dueAt: NOW + 5 * MIN });
    expect(buildQueue([soon], 'd1', NOW, 0).map((c) => c.id)).toEqual(['s']);
    const withNew = [soon, fresh({ id: 'n' })];
    expect(buildQueue(withNew, 'd1', NOW, 0).map((c) => c.id)).toEqual(['n']);
    const farOff = fresh({ id: 'f', phase: 'learning', dueAt: NOW + 60 * MIN });
    expect(buildQueue([farOff], 'd1', NOW, 0)).toHaveLength(0);
  });

  it('review cards count as due until local midnight, not after', () => {
    const tonight = fresh({ id: 'a', phase: 'review', intervalDays: 1, dueAt: endOfLocalDay(NOW) - 1 });
    const tomorrow = fresh({ id: 'b', phase: 'review', intervalDays: 1, dueAt: endOfLocalDay(NOW) + 1 });
    const counts = dueCounts([tonight, tomorrow], NOW, {});
    expect(counts.d1.reviewCount).toBe(1);
  });

  it('clamps the new count by the daily allowance already used', () => {
    const cards = [fresh({ id: 'n1' }), fresh({ id: 'n2', variant: 1 })];
    expect(dueCounts(cards, NOW, {}).d1.newCount).toBe(2);
    expect(dueCounts(cards, NOW, { d1: NEW_PER_DAY }).d1.newCount).toBe(0);
  });
});

describe('isRewardableAnswer', () => {
  it('awards for any answer on a review-phase card', () => {
    const next = answerCard(reviewCard(10), 'again', NOW);
    expect(isRewardableAnswer('review', next)).toBe(true);
  });

  it('awards for graduation from learning, but not the steps before', () => {
    const step1 = answerCard(fresh(), 'good', NOW);
    expect(isRewardableAnswer('new', step1)).toBe(false);
    const graduated = answerCard(step1, 'good', NOW);
    expect(isRewardableAnswer('learning', graduated)).toBe(true);
  });

  it('never awards for relearning answers', () => {
    const lapsed = answerCard(reviewCard(20), 'again', NOW);
    const back = answerCard(lapsed, 'good', NOW);
    expect(isRewardableAnswer('relearning', back)).toBe(false);
  });
});
