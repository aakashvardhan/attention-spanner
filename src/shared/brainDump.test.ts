import { describe, expect, it } from 'vitest';
import { OllamaError } from './llm/ollama';
import {
  ASK_TIMEOUT_MS,
  MAX_DUMP_CHARS,
  DAILY_STEP_SYSTEM,
  NEXT_STEP_SYSTEM,
  askErrorMessage,
  doneToday,
  hoursShare,
  isDue,
  isRecurring,
  keepAfterRetries,
  systemFor,
  completeStep,
  isOnlyFeeling,
  isTooBig,
  nextStepPrompt,
  parkDump,
  parseNextStep,
  removeDump,
  retryPrompt,
  setNextStep,
  stepProblem,
  traceStages,
} from './brainDump';

describe('parkDump', () => {
  it('ignores an empty or whitespace dump', () => {
    expect(parkDump([], '', 1)).toEqual([]);
    expect(parkDump([], '  \n\t ', 1)).toEqual([]);
  });

  it('trims, caps and puts the newest first', () => {
    const one = parkDump([], '  first  ', 1);
    const two = parkDump(one, 'x'.repeat(MAX_DUMP_CHARS + 50), 2);
    expect(two.map((d) => d.createdAt)).toEqual([2, 1]);
    expect(two[1].text).toBe('first');
    expect(two[0].text).toHaveLength(MAX_DUMP_CHARS);
    expect(two[0].id).not.toBe(two[1].id);
  });
});

describe('removeDump / setNextStep', () => {
  const list = parkDump(parkDump([], 'a', 1), 'b', 2);

  it('removes only the named dump', () => {
    expect(removeDump(list, list[0].id).map((d) => d.text)).toEqual(['a']);
  });

  it('stores a step, or null for nothing actionable, on the named dump only', () => {
    const withStep = setNextStep(list, list[1].id, 'Email Sam');
    expect(withStep[1].nextStep).toBe('Email Sam');
    expect(withStep[0].nextStep).toBeUndefined();
    expect(setNextStep(list, list[0].id, null)[0].nextStep).toBeNull();
  });
});

describe('parseNextStep', () => {
  it('reads NONE in any case or punctuation as nothing to act on', () => {
    for (const reply of ['NONE', 'none.', ' None! ', '"NONE"', '**NONE**']) {
      expect(parseNextStep(reply)).toBeNull();
    }
    expect(parseNextStep('')).toBeNull();
  });

  it('reads NONE followed by an explanation as nothing to act on', () => {
    expect(parseNextStep('NONE — everything is done.')).toBeNull();
    expect(parseNextStep('NONE. The loop is closed.')).toBeNull();
    expect(parseNextStep('None needed.')).toBeNull();
  });

  it('skips a thinking block that leaked into the reply', () => {
    expect(parseNextStep('<think>\nThe user wants...\n</think>\n\nCall mom back.')).toBe('Call mom back.');
    expect(parseNextStep('<think>\n</think>\nNONE')).toBeNull();
  });

  it('reads a reply with no letters or digits as nothing', () => {
    expect(parseNextStep('...')).toBeNull();
    expect(parseNextStep('—')).toBeNull();
    expect(parseNextStep('Buy 2 eggs.')).toBe('Buy 2 eggs.');
  });

  it('drops a "Today" or "Day N" opener the model echoes from the prompt', () => {
    expect(parseNextStep('Today, focus on tempo squats.')).toBe('Focus on tempo squats.');
    expect(parseNextStep('Today, day 6: Practise sliding windows.')).toBe('Practise sliding windows.');
    expect(parseNextStep('Day 3: Drill subjunctive -ar verbs.')).toBe('Drill subjunctive -ar verbs.');
    expect(parseNextStep("Today's session: two-pointer drills.")).toBe('Two-pointer drills.');
    expect(parseNextStep('Today')).toBeNull();
  });

  it('reads a bare bullet as nothing', () => {
    expect(parseNextStep('- ')).toBeNull();
    expect(parseNextStep('*')).toBeNull();
  });

  it('keeps the first line and strips bullets, quotes, emphasis and a label', () => {
    expect(parseNextStep('- Open the draft and write one sentence.')).toBe('Open the draft and write one sentence.');
    expect(parseNextStep('Next step: "Reply to the advisor email."')).toBe('Reply to the advisor email.');
    expect(parseNextStep('\n\n**Book the dentist.**\nBecause it keeps coming back.')).toBe('Book the dentist.');
    expect(parseNextStep('1. Read section 3')).toBe('Read section 3');
    expect(parseNextStep('do the dishes')).toBe('Do the dishes');
  });
});

describe('completeStep / nextStepPrompt', () => {
  const [dump] = parkDump([], 'email advisor, book dentist', 1);
  const open = setNextStep([dump], dump.id, 'Email advisor');

  it('moves the current step into done and leaves the next one unasked', () => {
    const once = completeStep(open, dump.id);
    expect(once[0].done).toEqual(['Email advisor']);
    expect(once[0].nextStep).toBeUndefined();
    const twice = completeStep(setNextStep(once, dump.id, 'Call dentist'), dump.id);
    expect(twice[0].done).toEqual(['Email advisor', 'Call dentist']);
  });

  it('is a no-op without a current step', () => {
    expect(completeStep([dump], dump.id)).toEqual([dump]);
    expect(completeStep(setNextStep([dump], dump.id, null), dump.id)[0].done).toBeUndefined();
  });

  it('sends the dump alone, then with what is already done', () => {
    expect(nextStepPrompt(dump)).toBe('email advisor, book dentist');
    expect(nextStepPrompt(completeStep(open, dump.id)[0])).toBe(
      'email advisor, book dentist\n\nAlready done:\n- Email advisor',
    );
  });
});

describe('isOnlyFeeling', () => {
  it('fires only on a confident yes', () => {
    expect(isOnlyFeeling({ type: 'noul', noul: 0.88 })).toBe(true);
    expect(isOnlyFeeling({ type: 'noul', noul: 0.71 })).toBe(false);
    expect(isOnlyFeeling({ type: 'noul', noul: 0.03 })).toBe(false);
    expect(isOnlyFeeling(undefined)).toBe(false);
  });
});

describe('stepProblem', () => {
  const [dump] = parkDump([], 'groceries, call mom', 1);
  const withDone = { ...dump, done: ['Call mom back.'] };

  it('passes one short, new action', () => {
    expect(stepProblem('Buy groceries.', withDone)).toBeNull();
  });

  it('catches a step that repeats a done one, ignoring case and punctuation', () => {
    expect(stepProblem('call mom back', withDone)).toBe('already done');
  });

  it('catches two actions joined', () => {
    expect(stepProblem('Wash the dishes and fold laundry.', dump)).toBe('two actions joined');
    expect(stepProblem('Open the draft, then write a line.', dump)).toBe('two actions joined');
    expect(stepProblem('Buy milk; call mom.', dump)).toBe('two actions joined');
  });

  it('does not read "and" inside a word as a join', () => {
    expect(stepProblem('Email the landlord.', dump)).toBeNull();
    expect(stepProblem('Book the band.', dump)).toBeNull();
  });

  it('does not read a thousands separator as a join', () => {
    expect(stepProblem('Pay the $1,200 rent.', dump)).toBeNull();
    expect(stepProblem('Pay rent, then call mom.', dump)).toBe('two actions joined');
  });

  it('catches a step longer than 15 words', () => {
    expect(stepProblem('Write ' + 'one '.repeat(15) + 'line.', dump)).toBe('too long');
  });
});

describe('isTooBig', () => {
  const size = (hours: number) => ({
    type: 'choice' as const,
    choice: hours >= 0.5 ? 'hours or days' : 'a few minutes',
    probabilities: { 'a few minutes': 1 - hours, 'hours or days': hours },
  });

  it('fires from 0.45, where every measured small step stayed below 0.29', () => {
    expect(isTooBig(size(0.61))).toBe(true);
    expect(isTooBig(size(0.48))).toBe(true);
    expect(isTooBig(size(0.29))).toBe(false);
    expect(isTooBig(undefined)).toBe(false);
    expect(isTooBig({ type: 'noul', noul: 0.99 })).toBe(false);
  });
});

describe('retryPrompt', () => {
  it('after a counting rejection, says what to name instead', () => {
    const [d] = parkDump([], 'leetcode', 1);
    expect(
      retryPrompt({ ...d, kind: 'recurring' }, [{ step: 'Solve the fourth problem.', why: 'counting through a list' }]),
    ).toBe(
      'leetcode\n\nThis is day 1.\n\nRejected, do not reply with these:\n- Solve the fourth problem. (counting through a list)' +
        '\nName a skill or pattern to practise, not a position in a list.',
    );
  });

  const [dump] = parkDump([], 'apartment is a mess', 1);

  it('is the plain prompt on the first try', () => {
    expect(retryPrompt(dump, [])).toBe(nextStepPrompt(dump));
  });

  it('lists each rejected step with its reason', () => {
    expect(retryPrompt(dump, [{ step: 'Wash dishes and fold laundry.', why: 'two actions joined' }])).toBe(
      'apartment is a mess\n\nRejected, do not reply with these:\n- Wash dishes and fold laundry. (two actions joined)',
    );
  });
});

describe('hoursShare — Laya answers off the wire', () => {
  it('reads the share of "hours or days"', () => {
    expect(hoursShare({ type: 'choice', choice: 'a few minutes', probabilities: { 'hours or days': 0.3 } })).toBe(0.3);
  });

  it('is null for a missing, malformed or non-numeric answer, so the check passes rather than throws', () => {
    expect(hoursShare(undefined)).toBeNull();
    expect(hoursShare({ type: 'noul', noul: 0.9 })).toBeNull();
    expect(hoursShare({ type: 'choice' } as never)).toBeNull();
    expect(hoursShare({ type: 'choice', choice: 'x', probabilities: { 'hours or days': NaN } })).toBeNull();
    expect(hoursShare({ type: 'choice', choice: 'x', probabilities: { 'hours or days': '0.9' } } as never)).toBeNull();
    expect(isTooBig({ type: 'choice' } as never)).toBe(false);
  });
});

describe('askErrorMessage', () => {
  const tail = ' The dump is still parked.';

  it('names a timeout with its limit', () => {
    expect(askErrorMessage(new Error('x'), 'Ollama', true)).toBe(
      `Ollama took longer than ${ASK_TIMEOUT_MS / 1000} s.${tail}`,
    );
  });

  it('points a refused origin at the fix in Settings', () => {
    expect(askErrorMessage(new OllamaError('forbidden', 'Ollama refused this extension.'), 'Ollama', false)).toBe(
      `Ollama refused this extension; Settings → Local AI shows the fix.${tail}`,
    );
  });

  it('passes through Ollama and Claude messages, which are written for people', () => {
    expect(askErrorMessage(new OllamaError('model', 'That model is not installed in Ollama.'), 'Ollama', false)).toBe(
      `That model is not installed in Ollama.${tail}`,
    );
    expect(askErrorMessage(new Error('Claude rejected the API key.'), 'Claude', false)).toBe(
      `Claude rejected the API key.${tail}`,
    );
  });

  it('falls back to a plain line for anything else, and caps a long message', () => {
    expect(askErrorMessage(new TypeError('x is undefined'), 'Ollama', false)).toBe(`Ollama didn't answer.${tail}`);
    expect(askErrorMessage('boom', 'Claude', false)).toBe(`Claude didn't answer.${tail}`);
    expect(askErrorMessage(new Error('y'.repeat(500)), 'Claude', false).length).toBeLessThan(220);
  });
});

describe('traceStages — the trace as a row of chips', () => {
  it('names each stage once, in order, with the model standing in for its server', () => {
    expect(
      traceStages([
        'Laya · something to act on (feeling 3%, 78 ms)',
        'Ollama · qwen3:8b · try 1: "Email advisor.", 438 ms',
        'Check · passed (one action, new)',
      ]),
    ).toEqual([
      { name: 'Laya', state: 'done', tries: 0 },
      { name: 'qwen3:8b', state: 'done', tries: 1 },
      { name: 'Check', state: 'done', tries: 0 },
    ]);
  });

  it('counts tries and marks the stage in flight as active', () => {
    expect(
      traceStages([
        'Laya · skipped: with steps done, Ollama decides when the loop is closed',
        'Ollama · m · try 1: "Wash and fold.", 2 ms',
        'Check · two actions joined, asking again',
        'Ollama · m · try 2, working…',
      ]),
    ).toEqual([
      { name: 'Laya', state: 'skip', tries: 0 },
      { name: 'm', state: 'active', tries: 1 },
      { name: 'Check', state: 'active', tries: 0 },
    ]);
  });

  it('reads Laya being off or down as skipped, and a model with no answer as failed', () => {
    expect(traceStages(['Laya · off, Ollama alone', 'Ollama · m · no answer'])).toEqual([
      { name: 'Laya', state: 'skip', tries: 0 },
      { name: 'm', state: 'fail', tries: 0 },
    ]);
    expect(traceStages(['Laya · no answer, Claude alone'])[0].state).toBe('skip');
    expect(traceStages(['Ollama · not running'])).toEqual([{ name: 'Ollama', state: 'fail', tries: 0 }]);
    expect(traceStages(['Check · already done, no new step after 3 tries'])[0].state).toBe('fail');
  });

  it('keeps a Laya decision that made the model unnecessary as done', () => {
    expect(traceStages(['Laya · only a feeling (feeling 89%, 265 ms), Ollama not needed'])).toEqual([
      { name: 'Laya', state: 'done', tries: 0 },
    ]);
  });

  it('is empty for no lines', () => {
    expect(traceStages([])).toEqual([]);
  });
});

describe('recurring dumps — one step a day, each a little further', () => {
  const day = (iso: string) => new Date(iso).getTime();
  const [base] = parkDump([], 'want to get better at leetcode', day('2026-10-01T09:00'));
  const practice = { ...base, kind: 'recurring' as const };
  const choice = (better: number) => ({
    type: 'choice' as const,
    choice: better >= 0.5 ? 'keep getting better' : 'finish once',
    probabilities: { 'finish once': 1 - better, 'keep getting better': better },
  });

  it('is recurring from 0.75: practices measured 0.79-0.96, tasks 0.51-0.69', () => {
    expect(isRecurring(choice(0.91))).toBe(true);
    expect(isRecurring(choice(0.79))).toBe(true);
    expect(isRecurring(choice(0.69))).toBe(false);
    expect(isRecurring(undefined)).toBe(false);
    expect(isRecurring({ type: 'choice' } as never)).toBe(false);
  });

  it('asks for a daily session, with the last 7 days as days, oldest first', () => {
    expect(systemFor(practice)).toBe(DAILY_STEP_SYSTEM);
    expect(systemFor(base)).toBe(NEXT_STEP_SYSTEM);
    const done = Array.from({ length: 9 }, (_, i) => `Session ${i + 1}.`);
    const prompt = nextStepPrompt({ ...practice, done });
    expect(prompt).toBe(
      'want to get better at leetcode\n\nDays so far, oldest first:\n' +
        done
          .slice(2)
          .map((s, i) => `- Day ${i + 3}: ${s}`)
          .join('\n') +
        '\n\nThis is day 10.',
    );
    expect(nextStepPrompt(practice)).toBe('want to get better at leetcode\n\nThis is day 1.');
  });

  it('leaves counting steps out of the history, so the model is not taught to count on', () => {
    const done = [
      'Make a list of the top 100 problems.',
      'Solve the first problem in the top 100 list.',
      'Drill two-pointer on sorted arrays.',
      'Solve problem 3.',
    ];
    expect(nextStepPrompt({ ...practice, done })).toBe(
      'want to get better at leetcode\n\nDays so far, oldest first:\n' +
        '- Day 1: Make a list of the top 100 problems.\n- Day 3: Drill two-pointer on sorted arrays.\n\nThis is day 5.',
    );
  });

  it('catches a done step reworded with another verb, for any dump', () => {
    const withDone = { ...base, done: ['Solve the third problem in the top 100 list.'] };
    expect(stepProblem('Work on the third problem in the top 100 list.', withDone)).toBe('already done');
    const email = { ...base, done: ['Email advisor about the deadline.'] };
    expect(stepProblem('Book the dentist.', email)).toBeNull();
    const gym = { ...base, done: ['Do 3 sets of 10 push-ups.'] };
    expect(stepProblem('Do 3 sets of 10 squats.', gym)).toBeNull();
  });

  it('rejects counting through a list, for a practice only', () => {
    for (const step of [
      'Work on the fourth problem in the top 100 list.',
      'Solve problem 4.',
      'Do the next exercise.',
    ]) {
      expect(stepProblem(step, practice)).toBe('counting through a list');
    }
    expect(stepProblem('Solve problem 4.', base)).toBeNull();
    expect(stepProblem('Solve one medium two-pointer problem without hints.', practice)).toBeNull();
  });

  it('lets one practice session cover a few related things; a task step stays one action', () => {
    const verbs = 'Conjugate present-tense -ar, -er and -ir verbs aloud.';
    expect(stepProblem(verbs, practice)).toBeNull();
    expect(stepProblem(verbs, base)).toBe('two actions joined');
  });

  it('gives a practice session 20 words, a task 15', () => {
    const sixteen = 'Practise ' + 'one '.repeat(14) + 'drill.';
    expect(stepProblem(sixteen, base)).toBe('too long');
    expect(stepProblem(sixteen, practice)).toBeNull();
  });

  it('never keeps a repeat when the tries run out', () => {
    expect(keepAfterRetries([{ step: 'A.', why: 'already done' }])).toBeNull();
    expect(keepAfterRetries([{ step: 'A.', why: 'counting through a list' }])).toBeNull();
    expect(keepAfterRetries([{ step: 'NONE', why: 'a practice has no end' }])).toBeNull();
    expect(keepAfterRetries([{ step: 'NONE', why: 'gave up' }])).toBeNull();
    expect(
      keepAfterRetries([
        { step: 'Long one.', why: 'too long' },
        { step: 'A.', why: 'already done' },
      ]),
    ).toBe('Long one.');
  });

  it('records when a step was done, and is due again the next local day', () => {
    const open = setNextStep([practice], practice.id, 'Two-pointer drill.');
    const [ticked] = completeStep(open, practice.id, day('2026-10-02T21:30'));
    expect(ticked.lastDoneAt).toBe(day('2026-10-02T21:30'));
    expect(doneToday(ticked, day('2026-10-02T23:59'))).toBe(true);
    expect(isDue(ticked, day('2026-10-02T23:59'))).toBe(false);
    expect(doneToday(ticked, day('2026-10-03T00:01'))).toBe(false);
    expect(isDue(ticked, day('2026-10-03T00:01'))).toBe(true);
  });

  it('is never due when closed, or when it is not recurring', () => {
    const now = day('2026-10-05T09:00');
    expect(isDue({ ...practice, nextStep: null }, now)).toBe(false);
    expect(isDue(base, now)).toBe(false);
    expect(isDue(practice, now)).toBe(true);
  });
});
