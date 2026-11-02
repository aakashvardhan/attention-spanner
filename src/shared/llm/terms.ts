import { MATH_RULE, type AiRequest } from './generate';

/**
 * Click-to-define in the reader: the word you clicked and the text around it.
 * The model widens the word to the term it belongs to ("difference" in
 * "temporal-difference learning") and defines that term as the paper uses it.
 */

export const DEFINE_SYSTEM =
  'You define terminology for someone reading a research paper who is new to the field. You get ' +
  'a passage from the paper and the word the reader clicked in it. Find the term that word ' +
  'belongs to: a named method, metric, acronym or piece of jargon, or the word itself if it ' +
  'stands alone. Define it as this paper uses it, drawing on your own knowledge where the passage ' +
  'does not define it. Reply in exactly this form: **Term**: definition. The definition is one ' +
  'or two plain sentences, at most 40 words. No preamble, no emoji, no mention of the passage.' +
  MATH_RULE;

export function defineRequest(opts: {
  key: string;
  word: string;
  context: string;
  near: string;
}): AiRequest {
  return {
    task: 'terms',
    source: 'arxiv',
    system: DEFINE_SYSTEM,
    passages: [opts.context],
    prompt: `The reader clicked "${opts.word}". Define the term it belongs to.`,
    cacheKey: `${opts.key}:${opts.near}`,
  };
}
