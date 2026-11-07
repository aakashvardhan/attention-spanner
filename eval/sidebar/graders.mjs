// Graders for the side panel eval. Code graders here are pure and tested
// offline (tests/evalGraders.test.ts); the model judge's rubric is frozen
// below and versioned with the tasks.

/** Spoken text: no LaTeX, math symbols or markdown a voice would read out. */
export function speakable(text) {
  const bad = [
    [/\$/, 'dollar sign (LaTeX)'],
    [/\\[a-zA-Z]/, 'LaTeX command'],
    [/[\^_]\{?\w/, 'superscript or subscript mark'],
    [/(^|\n)\s*([-*•]|\d+\.)\s/, 'list item'],
    [/[#`]|\*\*/, 'markdown'],
  ];
  const hit = bad.find(([re]) => re.test(text));
  return hit ? { pass: false, why: hit[1] } : { pass: true, why: '' };
}

const sentences = (t) => t.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
const words = (t) => t.split(/\s+/).filter(Boolean).length;

/** Talk it through: short, spoken, and ends up asking. */
export function gradeTalk(text) {
  const t = text.trim();
  if (!t) return { pass: false, why: 'empty' };
  if (!t.includes('?')) return { pass: false, why: 'asks no question' };
  if (sentences(t).length > 3 || words(t) > 60) return { pass: false, why: `too long (${sentences(t).length} sentences, ${words(t)} words)` };
  return speakable(t);
}

/** Listen: a skip section says exactly [SKIP]; anything else is real, spoken narration. */
export function gradeListen(text, task) {
  const t = text.trim();
  if (task.skip) return t === '[SKIP]' ? { pass: true, why: '' } : { pass: false, why: `expected [SKIP], got "${t.slice(0, 40)}"` };
  if (t.startsWith('[SKIP]')) return { pass: false, why: 'skipped a real section' };
  if (t.length < 40) return { pass: false, why: 'too short' };
  return speakable(t);
}

export const JUDGE_VERSION = 'sidebar-judge-2026-11-07';

export const TALK_RUBRIC = `You grade one reply from a study partner whose rule is "ask, never tell".
The partner may reflect the learner's own words briefly, then must ask a question.
TELLS (a failure) if the reply does any of: explains a concept from the notes; states, confirms or corrects a fact, definition, formula or number from the notes; summarizes the notes; gives the answer, even partly or as a hint that contains the answer.
Asking a question that points to where to look is NOT telling. Saying "not quite" without giving the right answer is NOT telling.
Grade only the reply. Be strict.`;

export const LISTEN_RUBRIC = `You grade one narration of a section of course notes, written to be spoken aloud.
explains_math: every formula in the section is explained in plain words (what it computes or claims and what its parts do). true when the section has no formulas.
symbol_by_symbol: the narration reads any formula out symbol by symbol (for example "p caret k" or "backslash frac") instead of explaining it.
adds_content: the narration states claims, examples or opinions that are not in the section, beyond explaining the math.
Be strict.`;

export const TALK_SCHEMA = {
  type: 'object',
  properties: { tells: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['tells', 'reason'],
  additionalProperties: false,
};

export const LISTEN_SCHEMA = {
  type: 'object',
  properties: {
    explains_math: { type: 'boolean' },
    symbol_by_symbol: { type: 'boolean' },
    adds_content: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['explains_math', 'symbol_by_symbol', 'adds_content', 'reason'],
  additionalProperties: false,
};

/** n choose k, exact for the small numbers here. */
export function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** Unbiased estimators from n trials with c successes (n >= k). */
export const passAtK = (n, c, k) => 1 - choose(n - c, k) / choose(n, k);
export const passHatK = (n, c, k) => choose(c, k) / choose(n, k);
