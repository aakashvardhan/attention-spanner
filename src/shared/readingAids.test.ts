import { describe, expect, it } from 'vitest';
import {
  blockAtLine,
  crossedSection,
  minutesLeft,
  sectionDoneLabel,
  timeLeftLabel,
  wordCounts,
} from './readingAids';

describe('minutesLeft', () => {
  const counts = wordCounts(['one two three four', 'x '.repeat(460), 'y '.repeat(230)]);

  it('counts words, ignoring extra whitespace', () => {
    expect(counts).toEqual([4, 460, 230]);
  });

  it('counts the rest of the current passage plus everything after it at 230 wpm', () => {
    expect(minutesLeft(counts, 1, 0)).toBe(3);
    expect(minutesLeft(counts, 1, 0.5)).toBe(2);
    expect(minutesLeft(counts, 2, 1)).toBe(0);
  });

  it('is null until the text exists', () => {
    expect(minutesLeft(null, 0, 0)).toBeNull();
  });

  it('clamps an index past the end', () => {
    expect(minutesLeft(counts, 9, 0)).toBe(0);
  });
});

describe('timeLeftLabel', () => {
  it('says nothing without an estimate, and never "0 min"', () => {
    expect(timeLeftLabel(null)).toBe('');
    expect(timeLeftLabel(0)).toBe('almost done');
    expect(timeLeftLabel(11)).toBe('about 11 min left');
  });
});

describe('crossedSection', () => {
  it('reports a section finished by reading forward into the next one', () => {
    expect(crossedSection(2, 3)).toBe(2);
  });

  it('stays quiet for jumps, backtracking, and documents without an outline', () => {
    expect(crossedSection(2, 5)).toBeNull();
    expect(crossedSection(3, 2)).toBeNull();
    expect(crossedSection(-1, 0)).toBeNull();
    expect(crossedSection(-1, -1)).toBeNull();
    expect(crossedSection(2, 2)).toBeNull();
  });
});

describe('sectionDoneLabel', () => {
  it('counts what is left', () => {
    expect(sectionDoneLabel(2, 6)).toBe('Section 3 done · 3 left');
    expect(sectionDoneLabel(4, 6)).toBe('Section 5 done · 1 left');
    expect(sectionDoneLabel(5, 6)).toBe('Last section done');
  });
});

describe('blockAtLine', () => {
  // Block bottoms in viewport coordinates, top to bottom.
  const bottoms = [-200, 120, 380, 700, 1100];

  it('is the first block whose bottom reaches the reading line', () => {
    expect(blockAtLine(bottoms, 360)).toBe(2);
    expect(blockAtLine(bottoms, 380)).toBe(2);
    expect(blockAtLine(bottoms, 381)).toBe(3);
  });

  it('skips blocks scrolled away above the line', () => {
    expect(blockAtLine(bottoms, 0)).toBe(1);
  });

  it('falls back to the last block below the end, and 0 for nothing', () => {
    expect(blockAtLine(bottoms, 5000)).toBe(4);
    expect(blockAtLine([], 100)).toBe(0);
  });
});
