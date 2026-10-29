import { MATH_RULE, type AiRequest } from './generate';
import type { AiSource } from './route';

/** Question-only prompts for the reader: the model asks, the reader answers. */

export const NO_ANSWER_RULE =
  ' Never answer, summarise, explain or solve. Ask exactly one question, at most 30 words. No preamble, no emoji.';

export const FALLBACK = {
  equation: 'In your own words, what does this line do?',
  breakdown: [
    'What does each symbol stand for?',
    'Which term would change the result most if it were removed?',
    'What would have to be true for this to hold?',
  ],
  question: 'Where in the paper would you look for this?',
  lock: 'What would have to be true for this page’s claim to hold, and does it?',
} as const;

const EQUATION_SYSTEM =
  'You coach someone reading a research paper. You get a block of math from it. Ask one question ' +
  'that makes the reader state in their own words what it does.' +
  NO_ANSWER_RULE +
  MATH_RULE;

const BREAKDOWN_SYSTEM =
  'You coach someone reading a research paper. You get a block of math and the reader’s own guess ' +
  'at what it does. Reply with exactly three numbered questions (1. 2. 3.) that probe the weak ' +
  'spots in that guess, one per line, each at most 30 words. Never answer, summarise, explain or ' +
  'solve. No preamble, no emoji.' +
  MATH_RULE;

const LOCK_SYSTEM =
  'You coach someone reading a research paper. You get one page and the reader’s doubts so far. ' +
  'Ask one question that makes them test the page’s main claim against those doubts.' +
  NO_ANSWER_RULE +
  MATH_RULE;

const COUNTERPOINT_SYSTEM =
  'You check the reader’s reasoning, not the paper. You get a passage and what the reader wrote ' +
  'about it. If their reasoning has one possible gap or fallacy (a confounded comparison, ' +
  'correlation read as cause, overgeneralisation), reply in exactly this form:\n' +
  'Q: <one question of at most 30 words that makes them test it>\nGap: <the gap, named in a few words>\n' +
  'If it holds, reply exactly NONE. Never answer, summarise or explain. No preamble, no emoji.';

export function socraticSystem(): string {
  return (
    'You help someone reading a research paper. You get numbered passages ([n] is the page) and a ' +
    'question from the reader. Reply with one guiding question that points them at the page [n] ' +
    'where the answer can be found, never the answer itself.' +
    NO_ANSWER_RULE
  );
}

export function equationRequest(o: { key: string; page: number; block: string; source: AiSource }): AiRequest {
  return {
    task: 'provoke',
    source: o.source,
    system: EQUATION_SYSTEM,
    passages: [o.block],
    prompt: `This is from page ${o.page}. Ask your question.`,
    cacheKey: `eq:${o.key}:${o.page}`,
  };
}

export function breakdownRequest(o: {
  key: string;
  page: number;
  block: string;
  guess: string;
  source: AiSource;
}): AiRequest {
  return {
    task: 'provoke',
    source: o.source,
    system: BREAKDOWN_SYSTEM,
    passages: [o.block],
    prompt: `The reader's guess: ${o.guess}`,
    cacheKey: `bd:${o.key}:${o.page}:${o.guess}`,
  };
}

export function parseBreakdown(text: string): string[] {
  const qs = [...text.matchAll(/^\s*[1-3][.)]\s*(.+)$/gm)].map((m) => m[1].trim());
  return qs.length === 3 ? qs : [];
}

export function lockRequest(o: {
  key: string;
  page: number;
  pageText: string;
  doubts: string[];
  source: AiSource;
}): AiRequest {
  return {
    task: 'provoke',
    source: o.source,
    system: LOCK_SYSTEM,
    passages: [o.pageText],
    prompt: o.doubts.length
      ? `The reader's doubts so far:\n${o.doubts.map((d) => `- ${d}`).join('\n')}`
      : 'The reader has noted no doubts yet.',
    cacheKey: `lock:${o.key}:${o.page}:${o.doubts.length}`,
  };
}

export function counterpointRequest(o: {
  key: string;
  passage: string;
  reasoning: string;
  source: AiSource;
}): AiRequest {
  return {
    task: 'provoke',
    source: o.source,
    system: COUNTERPOINT_SYSTEM,
    passages: [o.passage],
    prompt: `The reader wrote: ${o.reasoning}`,
    cacheKey: `cp:${o.key}:${o.reasoning}`,
  };
}

export function parseCounterpoint(text: string): { question: string; gap: string } | null {
  const q = /^\s*Q:\s*(.+)$/m.exec(text)?.[1].trim();
  const gap = /^\s*Gap:\s*(.+)$/m.exec(text)?.[1].trim();
  return q && gap ? { question: q, gap } : null;
}
