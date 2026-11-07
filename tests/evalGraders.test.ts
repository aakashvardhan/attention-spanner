import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM without types
import { gradeListen, gradeTalk, passAtK, passHatK, speakable } from '../eval/sidebar/graders.mjs';

// The eval's code graders must reject wrong outputs and accept valid ones
// (agent-evaluation practice: validate graders before trusting scores).
describe('side panel eval graders', () => {
  it('talk: accepts a short spoken question, rejects telling-shaped or unspeakable replies', () => {
    expect(gradeTalk("Hm, what do you think happens to that number as you add more attempts?").pass).toBe(true);
    expect(gradeTalk('Pass to the k is the chance all k attempts succeed.').pass).toBe(false);
    expect(gradeTalk('What does $p^k$ mean here?').pass).toBe(false);
    expect(gradeTalk('- first\n- second?').pass).toBe(false);
    expect(gradeTalk('One. Two. Three. Four, right?').pass).toBe(false);
    expect(gradeTalk('').pass).toBe(false);
  });

  it('listen: a skip section must be exactly [SKIP]; real narration must be spoken prose', () => {
    expect(gradeListen('[SKIP]', { skip: true }).pass).toBe(true);
    expect(gradeListen('Home, course notes, readings.', { skip: true }).pass).toBe(false);
    expect(gradeListen('[SKIP]', {}).pass).toBe(false);
    expect(gradeListen('Section two: Reliability. If one try works with chance p, the chance that all k tries work is p multiplied by itself k times.', {}).pass).toBe(true);
    expect(gradeListen('Reliability. The formula is \\mathrm{pass}^k = p^k, which is used throughout the notes.', {}).pass).toBe(false);
  });

  it('speakable: flags LaTeX, sub/superscripts and markdown, not ordinary punctuation', () => {
    expect(speakable("It's 51.2 percent: about half.").pass).toBe(true);
    expect(speakable('x_i').pass).toBe(false);
    expect(speakable('**bold**').pass).toBe(false);
    expect(speakable('Use `code`').pass).toBe(false);
  });

  it('estimators match the closed forms and their edge cases', () => {
    expect(passHatK(5, 5, 3)).toBe(1);
    expect(passHatK(5, 2, 3)).toBe(0);
    expect(passHatK(5, 4, 3)).toBeCloseTo(0.4);
    expect(passAtK(5, 0, 3)).toBe(0);
    expect(passAtK(5, 3, 3)).toBe(1);
    expect(passAtK(5, 1, 3)).toBeCloseTo(0.6);
  });
});
