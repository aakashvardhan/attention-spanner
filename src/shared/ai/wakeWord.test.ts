import { describe, expect, it } from 'vitest';
import { levenshtein, matchWakeWord } from './wakeWord';

describe('levenshtein', () => {
  it('measures edit distance', () => {
    expect(levenshtein('jarvis', 'jarvis')).toBe(0);
    expect(levenshtein('jervis', 'jarvis')).toBe(1);
    expect(levenshtein('travis', 'jarvis')).toBe(3);
    expect(levenshtein('davis', 'jarvis')).toBe(2);
    expect(levenshtein('', 'jarvis')).toBe(6);
    expect(levenshtein('harvest', 'jarvis')).toBe(3);
  });
});

describe('matchWakeWord', () => {
  it('matches "hey jarvis" and extracts the command', () => {
    expect(matchWakeWord('hey jarvis add a task to buy milk')).toBe('add a task to buy milk');
    expect(matchWakeWord("Hey Jarvis, how's my streak?")).toBe('hows my streak');
  });

  it('returns empty string when the wake word is said alone', () => {
    expect(matchWakeWord('hey jarvis')).toBe('');
    expect(matchWakeWord('jarvis')).toBe('');
    expect(matchWakeWord('Jarvis.')).toBe('');
  });

  it('accepts close phonetic misrecognitions bare', () => {
    expect(matchWakeWord('jervis what time is it')).toBe('what time is it');
    expect(matchWakeWord('jarvus')).toBe('');
    expect(matchWakeWord('hey jarves start a sprint')).toBe('start a sprint');
  });

  it('accepts distance-2 lookalikes only after a hey-word', () => {
    expect(matchWakeWord('hey travis add a task')).toBe('add a task');
    expect(matchWakeWord('okay davis show my tasks')).toBe('show my tasks');
    expect(matchWakeWord('travis is coming over')).toBeNull();
    expect(matchWakeWord('davis')).toBeNull();
  });

  it('ignores unrelated speech', () => {
    expect(matchWakeWord('the harvest was good this year')).toBeNull();
    expect(matchWakeWord('lets talk about java')).toBeNull();
    expect(matchWakeWord('')).toBeNull();
    expect(matchWakeWord('   ')).toBeNull();
  });

  it('finds the wake word mid-sentence', () => {
    expect(matchWakeWord('um hey jarvis pause my focus')).toBe('pause my focus');
  });
});
