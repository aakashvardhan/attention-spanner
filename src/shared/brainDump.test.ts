import { describe, expect, it } from 'vitest';
import { OllamaError } from './llm/ollama';
import {
  ASK_TIMEOUT_MS,
  MAX_DUMP_CHARS,
  askErrorMessage,
  hoursShare,
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
