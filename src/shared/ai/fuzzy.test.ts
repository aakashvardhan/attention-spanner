import { describe, expect, it } from 'vitest';
import { fuzzyScore, scoreCommand } from './fuzzy';

describe('fuzzyScore', () => {
  it('ranks exact > prefix > substring > subsequence > none', () => {
    expect(fuzzyScore('start focus session', 'Start focus session')).toBe(100);
    expect(fuzzyScore('start', 'Start focus session')).toBe(90);
    expect(fuzzyScore('focus', 'Start focus session')).toBe(70);
    expect(fuzzyScore('sfs', 'Start focus session')).toBe(40);
    expect(fuzzyScore('xyz', 'Start focus session')).toBe(0);
  });

  it('is case-insensitive and rejects empties', () => {
    expect(fuzzyScore('FOCUS', 'start focus')).toBe(70);
    expect(fuzzyScore('', 'target')).toBe(0);
    expect(fuzzyScore('q', '')).toBe(0);
  });
});

describe('scoreCommand', () => {
  it('caps keyword matches below label matches', () => {
    expect(scoreCommand('gym', 'Gym check-in', ['workout'])).toBe(90);
    expect(scoreCommand('workout', 'Gym check-in', ['workout'])).toBe(65);
    expect(scoreCommand('nothing', 'Gym check-in', ['workout'])).toBe(0);
  });
});
