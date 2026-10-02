import { LOCAL_CONTEXT_CHARS } from '../constants';
import type { AiRequest } from './generate';
import type { AiSource } from './route';

/**
 * "Where you left off": a recap of only the part already read, so getting
 * back into a half-finished document costs a glance instead of a re-read.
 */

export const RECAP_SYSTEM =
  'You help a reader who has ADHD get back into a document they stopped partway through. ' +
  'Using only the text given, write exactly three short Markdown bullet points: what the ' +
  'part they read covered, in order, with the last bullet saying where they stopped. ' +
  'Plain and concrete. No preamble, no headings, no advice, no emoji.';

/** Worth a recap: started in earnest, not essentially finished. */
export function wantsRecap(percent: number): boolean {
  return percent >= 5 && percent < 95;
}

/**
 * The passages before the reader's furthest point. If that is more than the
 * local model takes, the most recent stretch wins — "where you stopped" is
 * what a recap is for, and the opening is the part most likely remembered.
 */
export function readSoFar(passages: string[], fraction: number): string[] {
  const end = Math.max(1, Math.ceil(passages.length * Math.min(1, Math.max(0, fraction))));
  const read = passages.slice(0, end);
  const kept: string[] = [];
  let budget = LOCAL_CONTEXT_CHARS;
  for (let i = read.length - 1; i >= 0; i--) {
    const text = read[i].trim();
    if (!text) continue;
    if (text.length > budget) {
      // Always say something about the latest passage, even an enormous one.
      if (kept.length === 0) kept.unshift(text.slice(-budget));
      break;
    }
    kept.unshift(text);
    budget -= text.length;
  }
  return kept;
}

export function recapRequest(opts: {
  key: string;
  passages: string[];
  percent: number;
  source: AiSource;
}): AiRequest {
  return {
    task: 'recap',
    source: opts.source,
    system: RECAP_SYSTEM,
    passages: readSoFar(opts.passages, opts.percent / 100),
    prompt: 'Recap what I have read so far.',
    // Bucketed to tens: a recap at 41% is still right at 47%, and regenerating
    // on every scroll would make the cache useless.
    cacheKey: `${opts.key}:${Math.floor(opts.percent / 10)}`,
  };
}
