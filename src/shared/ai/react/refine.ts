import {
  REACT_MAX_REFINE_ROUNDS,
  REACT_REFINE_MIN_CHARS,
} from '../../constants';
import { parseJsonObject } from '../assistant';
import { newTurn, type AssistantProvider } from '../assistantTypes';

/**
 * Second passes over an answer, generalizing verifier.ts from a single plan
 * check into an iterative draft -> critique -> revise.
 *
 * Both functions here follow verifyPlan's contract exactly: they NEVER throw
 * and never block. A failed critique returns the draft untouched, and a failed
 * sufficiency check reports "sufficient". Verification can improve an answer;
 * it must never be the reason the user gets nothing.
 *
 * Both are also gated on cost. A second model call is real money and real
 * latency, and most replies here are one line — so the critic skips short,
 * evidence-free answers outright, and the sufficiency check fires only on the
 * narrow failure mode it exists for (answering from a snapshot without having
 * looked anything up).
 */

export interface AnswerCritique {
  verdict: 'ok' | 'revise';
  issues: string[];
  /** The rewritten answer when the critic revised it */
  answer: string | null;
}

export function buildAnswerCriticSystem(question: string, evidence: string): string {
  return (
    "You check an assistant's draft answer against the evidence it gathered. " +
    'Flag anything the evidence does not support, any citation marker that names ' +
    'a source not present below, and anything that contradicts the evidence. ' +
    'Respond verdict "ok" when the draft is sound. Respond "revise" with a ' +
    'corrected answer ONLY when something is clearly wrong — do not rewrite for ' +
    'style, do not add information, and keep the original voice and length. ' +
    'Keep each issue to one short sentence.\n\n' +
    `Question: ${question}\n\nEvidence:\n${evidence}`
  );
}

export function buildAnswerCriticSchema(): object {
  return {
    type: 'object',
    required: ['verdict', 'issues'],
    additionalProperties: false,
    properties: {
      verdict: { type: 'string', enum: ['ok', 'revise'] },
      issues: { type: 'array', items: { type: 'string' } },
      answer: { type: 'string' },
    },
  };
}

/** Parse a critique; throws on junk, which callers treat as "critic failed" */
export function parseAnswerCritique(raw: string): AnswerCritique {
  const obj = parseJsonObject(raw);
  const verdict = obj.verdict === 'revise' ? 'revise' : 'ok';
  const issues = (Array.isArray(obj.issues) ? obj.issues : [])
    .filter((i): i is string => typeof i === 'string' && i.trim() !== '')
    .slice(0, 5);
  const answer =
    verdict === 'revise' && typeof obj.answer === 'string' && obj.answer.trim() !== ''
      ? obj.answer.trim()
      : null;
  return { verdict, issues, answer };
}

/**
 * Is this answer worth a critic pass? A one-line reply drawn from no evidence
 * has nothing to check against, and checking it would double the cost of the
 * cheapest possible turn.
 */
export function worthCritiquing(draft: string, evidenceCount: number): boolean {
  return evidenceCount > 0 && draft.trim().length >= REACT_REFINE_MIN_CHARS;
}

export interface RefinedAnswer {
  text: string;
  issues: string[];
  rounds: number;
}

/**
 * Critique and revise, stopping as soon as the critic is satisfied. Never
 * throws — on any failure the draft is returned unchanged.
 */
export async function refineAnswer(
  question: string,
  draft: string,
  evidence: string,
  chain: readonly AssistantProvider[],
  rounds = REACT_MAX_REFINE_ROUNDS,
): Promise<RefinedAnswer> {
  const critic = chain[0];
  if (!critic || rounds <= 0) return { text: draft, issues: [], rounds: 0 };

  let text = draft;
  const issues: string[] = [];
  let done = 0;

  for (let round = 0; round < rounds; round++) {
    try {
      const reply = await critic.generate({
        system: buildAnswerCriticSystem(question, evidence),
        turns: [newTurn('user', `Draft answer:\n${text}`)],
        responseSchema: buildAnswerCriticSchema(),
      });
      const critique = parseAnswerCritique(reply.text);
      done = round + 1;
      if (critique.verdict === 'ok') break;
      issues.push(...critique.issues);
      // A "revise" with no replacement is a complaint, not a correction — take
      // the issues and stop rather than looping on the same draft.
      if (!critique.answer) break;
      text = critique.answer;
    } catch {
      break;
    }
  }
  return { text, issues, rounds: done };
}

export interface Sufficiency {
  sufficient: boolean;
  missing: string[];
}

export function buildSufficiencySchema(): object {
  return {
    type: 'object',
    required: ['sufficient'],
    additionalProperties: false,
    properties: {
      sufficient: { type: 'boolean' },
      missing: { type: 'array', items: { type: 'string' } },
    },
  };
}

export function parseSufficiency(raw: string): Sufficiency {
  const obj = parseJsonObject(raw);
  const missing = (Array.isArray(obj.missing) ? obj.missing : [])
    .filter((m): m is string => typeof m === 'string' && m.trim() !== '')
    .slice(0, 3);
  // Only an explicit false counts: anything ambiguous means "go ahead".
  return { sufficient: obj.sufficient !== false, missing };
}

/**
 * Would answering now be guessing? Runs on the cheap tier and defaults to
 * "sufficient" on any failure, so this can only ever cause MORE looking up,
 * never a blocked answer.
 */
export async function checkSufficiency(
  question: string,
  evidence: string,
  chain: readonly AssistantProvider[],
): Promise<Sufficiency> {
  const judge = chain[0];
  if (!judge) return { sufficient: true, missing: [] };
  try {
    const reply = await judge.generate({
      system:
        'You judge whether an assistant can answer a question from what it has ' +
        'gathered, or whether it would be guessing. Answer sufficient=true unless ' +
        'something specific and lookup-able is missing. When false, name at most ' +
        'three missing things in a few words each.',
      turns: [newTurn('user', `Question: ${question}\n\nGathered so far:\n${evidence || '(nothing)'}`)],
      responseSchema: buildSufficiencySchema(),
    });
    return parseSufficiency(reply.text);
  } catch {
    return { sufficient: true, missing: [] };
  }
}
