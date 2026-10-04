import { LAYA_PREFILL_MIN } from '../constants';
import type { Deck, Paper, PaperKind } from '../types';
import { clip, confident, layaReady, systemOne, type LayaAnswer, type LayaQuestion } from './laya';

/**
 * Filing a new paper: which deck it belongs in and what kind of paper it is,
 * suggested from its title and abstract. Only a suggestion the user sees in
 * the form before saving, and only when Laya is at least LAYA_PREFILL_MIN
 * sure — an ambiguous paper (method or theory?) gets no suggestion at all.
 *
 * No priority: Laya's score head ranked MapReduce above DDIM for a diffusion
 * thesis, so it is not asked.
 */

export const PAPER_KINDS: Record<PaperKind, string> = {
  survey: 'reviews a field',
  method: 'proposes a new technique',
  benchmark: 'introduces an evaluation or benchmark',
  dataset: 'releases a dataset',
  position: 'argues a viewpoint',
  theory: 'proves theoretical results',
};

export interface IntakeSuggestion {
  deckId: string | null;
  kind: PaperKind | null;
}

/**
 * A deck is described by a couple of the papers already in it, which says far
 * more than a name like "Thesis". One deck means nothing to choose.
 */
export function intakeQuestions(
  decks: readonly Deck[],
  papers: readonly Paper[],
): Partial<Record<'deck' | 'kind', LayaQuestion>> {
  const questions: Partial<Record<'deck' | 'kind', LayaQuestion>> = {
    kind: { type: 'choice', instructions: 'What kind of paper is this?', criteria: PAPER_KINDS },
  };
  if (decks.length >= 2) {
    const criteria: Record<string, string | null> = {};
    for (const deck of decks) {
      const titles = papers.filter((p) => p.deckId === deck.id).slice(0, 2).map((p) => clip(p.title, 50));
      criteria[deck.name] = titles.length ? `e.g. ${titles.join('; ')}` : null;
    }
    questions.deck = {
      type: 'choice',
      instructions: 'Which reading-list deck does this paper belong in?',
      criteria,
    };
  }
  return questions;
}

export function readIntake(
  answers: Partial<Record<'deck' | 'kind', LayaAnswer>>,
  decks: readonly Deck[],
  min = LAYA_PREFILL_MIN,
): IntakeSuggestion {
  const deckName = confident(answers.deck, min);
  const kind = confident(answers.kind, min);
  return {
    deckId: decks.find((d) => d.name === deckName)?.id ?? null,
    kind: typeof kind === 'string' && kind in PAPER_KINDS ? (kind as PaperKind) : null,
  };
}

/** Null when Laya is off or not running; a failed call is no suggestion, not an error. */
export async function suggestIntake(
  layaUrl: string,
  paper: { title: string; abstract: string; venue: string },
  decks: readonly Deck[],
  papers: readonly Paper[],
): Promise<IntakeSuggestion | null> {
  if (!paper.title.trim() || !(await layaReady(layaUrl))) return null;
  const state = { title: paper.title, venue: paper.venue, abstract: clip(paper.abstract, 1500) };
  try {
    return readIntake(await systemOne(layaUrl, state, intakeQuestions(decks, papers)), decks);
  } catch {
    return null;
  }
}
