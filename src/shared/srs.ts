import { clozeIndexes } from './cloze';
import type { CardPhase, FlashCard, FlashNote, Rating, SrsDayStats } from './types';

/**
 * Anki-classic SM-2 scheduler. Pure functions only: every entry point takes
 * `now` (ms epoch) so tests inject time. No fuzz in v1 — if added later it
 * belongs at the end of answerCard, jittering review intervals by ±5%.
 */

export const LEARNING_STEPS_MIN = [1, 10] as const;
export const RELEARNING_STEPS_MIN = [10] as const;
export const GRADUATING_INTERVAL_DAYS = 1;
export const EASY_INTERVAL_DAYS = 4;
export const START_EASE = 2.5;
export const MIN_EASE = 1.3;
export const NEW_PER_DAY = 20;
export const MAX_INTERVAL_DAYS = 36500;
export const LEARN_AHEAD_MIN = 20;

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

export function newCard(noteId: string, deckId: string, variant: number, now: number): FlashCard {
  return {
    id: `${noteId}#${variant}`,
    noteId,
    deckId,
    variant,
    phase: 'new',
    stepIndex: 0,
    ease: START_EASE,
    intervalDays: 0,
    dueAt: now,
    lapses: 0,
    reps: 0,
    createdAt: now,
  };
}

function clampEase(ease: number): number {
  return Math.max(MIN_EASE, Math.round(ease * 100) / 100);
}

function clampInterval(days: number): number {
  return Math.min(MAX_INTERVAL_DAYS, days);
}

function graduate(card: FlashCard, intervalDays: number, now: number): FlashCard {
  return {
    ...card,
    phase: 'review',
    stepIndex: 0,
    intervalDays,
    dueAt: now + intervalDays * DAY_MS,
  };
}

export function answerCard(card: FlashCard, rating: Rating, now: number): FlashCard {
  const next = ((): FlashCard => {
    if (card.phase === 'new' || card.phase === 'learning') {
      const steps = LEARNING_STEPS_MIN;
      switch (rating) {
        case 'again':
          return { ...card, phase: 'learning', stepIndex: 0, dueAt: now + steps[0] * MIN_MS };
        case 'hard': {
          // Repeat the current step
          const step = steps[Math.min(card.stepIndex, steps.length - 1)];
          return { ...card, phase: 'learning', dueAt: now + step * MIN_MS };
        }
        case 'good': {
          const nextStep = card.phase === 'new' ? 1 : card.stepIndex + 1;
          if (nextStep >= steps.length) return graduate(card, GRADUATING_INTERVAL_DAYS, now);
          return { ...card, phase: 'learning', stepIndex: nextStep, dueAt: now + steps[nextStep] * MIN_MS };
        }
        case 'easy':
          return graduate(card, EASY_INTERVAL_DAYS, now);
      }
    }

    if (card.phase === 'review') {
      const i = card.intervalDays;
      switch (rating) {
        case 'again':
          // Lapse: ease penalty, relearn steps; post-relearn interval is 1 day
          return {
            ...card,
            phase: 'relearning',
            stepIndex: 0,
            ease: clampEase(card.ease - 0.2),
            lapses: card.lapses + 1,
            intervalDays: 1,
            dueAt: now + RELEARNING_STEPS_MIN[0] * MIN_MS,
          };
        case 'hard': {
          const interval = clampInterval(Math.max(i + 1, Math.round(i * 1.2)));
          return {
            ...card,
            ease: clampEase(card.ease - 0.15),
            intervalDays: interval,
            dueAt: now + interval * DAY_MS,
          };
        }
        case 'good': {
          const interval = clampInterval(Math.max(i + 1, Math.round(i * card.ease)));
          return { ...card, intervalDays: interval, dueAt: now + interval * DAY_MS };
        }
        case 'easy': {
          const interval = clampInterval(Math.max(i + 1, Math.round(i * card.ease * 1.3)));
          return {
            ...card,
            ease: clampEase(card.ease + 0.15),
            intervalDays: interval,
            dueAt: now + interval * DAY_MS,
          };
        }
      }
    }

    // relearning
    const steps = RELEARNING_STEPS_MIN;
    switch (rating) {
      case 'again':
        // No further ease penalty on relearn misses (Anki behavior)
        return { ...card, stepIndex: 0, dueAt: now + steps[0] * MIN_MS };
      case 'hard': {
        const step = steps[Math.min(card.stepIndex, steps.length - 1)];
        return { ...card, dueAt: now + step * MIN_MS };
      }
      case 'good': {
        const nextStep = card.stepIndex + 1;
        if (nextStep >= steps.length) return graduate(card, card.intervalDays, now);
        return { ...card, stepIndex: nextStep, dueAt: now + steps[nextStep] * MIN_MS };
      }
      case 'easy':
        return graduate(card, card.intervalDays, now);
    }
  })();

  return { ...next, reps: card.reps + 1 };
}

/** Human label for a duration, matching Anki's answer-button previews */
export function formatInterval(ms: number): string {
  const mins = Math.round(ms / MIN_MS);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const days = ms / DAY_MS;
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${(days / 30.44).toFixed(1).replace(/\.0$/, '')}mo`;
  return `${(days / 365.25).toFixed(1).replace(/\.0$/, '')}yr`;
}

export function previewIntervals(card: FlashCard, now: number): Record<Rating, string> {
  const out = {} as Record<Rating, string>;
  for (const rating of ['again', 'hard', 'good', 'easy'] as const) {
    out[rating] = formatInterval(answerCard(card, rating, now).dueAt - now);
  }
  return out;
}

/** Variant numbers a note should have cards for */
export function cardsForNote(note: FlashNote): number[] {
  if (note.type === 'cloze') return clozeIndexes(note.front);
  return note.reversed ? [0, 1] : [0];
}

/**
 * Reconcile a note's cards after create/edit: surviving variants keep their
 * scheduling state, new variants start fresh, removed variants are dropped.
 */
export function reconcileCards(note: FlashNote, existing: FlashCard[], now: number): FlashCard[] {
  const byVariant = new Map(existing.map((c) => [c.variant, c]));
  return cardsForNote(note).map(
    (variant) =>
      byVariant.get(variant) ?? newCard(note.id, note.deckId, variant, now),
  );
}

/** Local end of day (exclusive): review cards are "due today" until local midnight */
export function endOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * Ordered study queue for one deck:
 * 1. learning/relearning cards already due,
 * 2. new cards (oldest first) within the remaining daily allowance,
 * 3. review cards due today,
 * 4. if all else is empty, learning cards due within LEARN_AHEAD_MIN.
 */
export function buildQueue(
  cards: FlashCard[],
  deckId: string,
  now: number,
  newIntroducedToday: number,
): FlashCard[] {
  const deck = cards.filter((c) => c.deckId === deckId);
  const byDue = (a: FlashCard, b: FlashCard) => a.dueAt - b.dueAt;

  const learning = deck
    .filter((c) => (c.phase === 'learning' || c.phase === 'relearning') && c.dueAt <= now)
    .sort(byDue);
  const fresh = deck
    .filter((c) => c.phase === 'new')
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, Math.max(0, NEW_PER_DAY - newIntroducedToday));
  const review = deck
    .filter((c) => c.phase === 'review' && c.dueAt <= endOfLocalDay(now))
    .sort(byDue);

  const queue = [...learning, ...fresh, ...review];
  if (queue.length > 0) return queue;

  return deck
    .filter(
      (c) =>
        (c.phase === 'learning' || c.phase === 'relearning') &&
        c.dueAt <= now + LEARN_AHEAD_MIN * MIN_MS,
    )
    .sort(byDue);
}

export interface DeckDueCounts {
  newCount: number;
  learningCount: number;
  reviewCount: number;
}

/** Due counts per deck — shared by deck list, dashboard card, and popup tab */
export function dueCounts(
  cards: FlashCard[],
  now: number,
  newIntroducedByDeck: Record<string, number>,
): Record<string, DeckDueCounts> {
  const endOfDay = endOfLocalDay(now);
  const out: Record<string, DeckDueCounts> = {};
  for (const card of cards) {
    const counts = (out[card.deckId] ??= { newCount: 0, learningCount: 0, reviewCount: 0 });
    if (card.phase === 'new') counts.newCount += 1;
    else if ((card.phase === 'learning' || card.phase === 'relearning') && card.dueAt <= now)
      counts.learningCount += 1;
    else if (card.phase === 'review' && card.dueAt <= endOfDay) counts.reviewCount += 1;
  }
  for (const [deckId, counts] of Object.entries(out)) {
    const allowance = Math.max(0, NEW_PER_DAY - (newIntroducedByDeck[deckId] ?? 0));
    counts.newCount = Math.min(counts.newCount, allowance);
  }
  return out;
}

/** Total cards due across all decks (dashboard headline / popup badge) */
export function totalDue(counts: Record<string, DeckDueCounts>): number {
  return Object.values(counts).reduce(
    (sum, c) => sum + c.newCount + c.learningCount + c.reviewCount,
    0,
  );
}

/** newIntroduced-by-deck for today, from the srsDaily aggregate */
export function newIntroducedToday(
  srsDaily: Record<string, SrsDayStats>,
  todayKey: string,
): Record<string, number> {
  return srsDaily[todayKey]?.newIntroduced ?? {};
}

/** True when answering this card should award XP (see gamification design) */
export function isRewardableAnswer(prevPhase: CardPhase, next: FlashCard): boolean {
  if (prevPhase === 'review') return true;
  return (prevPhase === 'new' || prevPhase === 'learning') && next.phase === 'review';
}
