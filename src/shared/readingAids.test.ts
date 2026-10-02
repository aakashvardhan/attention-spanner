import { describe, expect, it } from 'vitest';
import {
  crossedSection,
  DRIFT_AWAY_MS,
  DRIFT_IDLE_MS,
  driftStep,
  minutesLeft,
  sectionDoneLabel,
  timeLeftLabel,
  wordCounts,
  type DriftState,
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

describe('driftStep', () => {
  const start: DriftState = { lastActivity: 0, hiddenAt: null, nudged: false };
  const run = (events: [DriftEvent['type'], number][]) => {
    let state = start;
    return events.map(([type, at]) => {
      const out = driftStep(state, { type, at });
      state = out.state;
      return out.nudge;
    });
  };
  type DriftEvent = Parameters<typeof driftStep>[1];

  it('nudges once after idling in view, and not again until there is activity', () => {
    expect(run([['tick', DRIFT_IDLE_MS - 1], ['tick', DRIFT_IDLE_MS], ['tick', DRIFT_IDLE_MS + 60_000]])).toEqual([false, true, false]);
  });

  it('re-arms after activity', () => {
    expect(run([['tick', DRIFT_IDLE_MS], ['activity', DRIFT_IDLE_MS + 1], ['tick', 2 * DRIFT_IDLE_MS + 1]])).toEqual([true, false, true]);
  });

  it('nudges on return from a long absence, once', () => {
    expect(run([['hidden', 1000], ['visible', 1000 + DRIFT_AWAY_MS + 1], ['tick', 1000 + DRIFT_AWAY_MS + 2]])).toEqual([false, true, false]);
  });

  it('does not nudge for a short tab switch, and does not count idle time while hidden', () => {
    expect(run([['hidden', 1000], ['tick', 1000 + DRIFT_IDLE_MS], ['visible', 1000 + DRIFT_AWAY_MS - 1]])).toEqual([false, false, false]);
  });
});
