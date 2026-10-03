import { describe, expect, it } from 'vitest';
import { MAX_DUMP_CHARS, parkDump, parseNextStep, removeDump, setNextStep } from './brainDump';

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

  it('keeps the first line and strips bullets, quotes, emphasis and a label', () => {
    expect(parseNextStep('- Open the draft and write one sentence.')).toBe('Open the draft and write one sentence.');
    expect(parseNextStep('Next step: "Reply to the advisor email."')).toBe('Reply to the advisor email.');
    expect(parseNextStep('\n\n**Book the dentist.**\nBecause it keeps coming back.')).toBe('Book the dentist.');
    expect(parseNextStep('1. Read section 3')).toBe('Read section 3');
  });
});
