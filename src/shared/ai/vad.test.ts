import { describe, expect, it } from 'vitest';
import {
  LIVE_SEGMENT_MAX_MS,
  LIVE_SEGMENT_MIN_MS,
  VAD_MIN_SPEECH_MS,
  VAD_PEAK_THRESHOLD,
  VAD_RMS_THRESHOLD,
  VAD_SILENCE_MS,
} from '../constants';
import {
  hadSpeech,
  newVadState,
  peakOf,
  rmsOf,
  shouldRotate,
  silenceMs,
  vadStep,
  type VadState,
} from './vad';

const LOUD = VAD_RMS_THRESHOLD * 2;
const QUIET = VAD_RMS_THRESHOLD / 4;

/** Drive the detector for `ms` at one loudness, one sample every `step` ms. */
function run(state: VadState, rms: number, ms: number, startAt: number, step = 20): VadState {
  let s = state;
  for (let t = step; t <= ms; t += step) s = vadStep(s, rms, 0, startAt + t);
  return s;
}

describe('rmsOf', () => {
  it('is 0 for silence and 1 for a full-scale square wave', () => {
    expect(rmsOf([0, 0, 0, 0])).toBe(0);
    expect(rmsOf([1, -1, 1, -1])).toBe(1);
  });

  it('is 0 for an empty buffer rather than NaN', () => {
    expect(rmsOf([])).toBe(0);
  });

  it('averages energy, so one spike in a quiet window stays low', () => {
    // The case peakOf exists to catch: a consonant RMS smooths away.
    expect(rmsOf([1, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeLessThan(VAD_RMS_THRESHOLD * 30);
    expect(peakOf([1, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(1);
  });
});

describe('peakOf', () => {
  it('takes the largest magnitude regardless of sign', () => {
    expect(peakOf([0.1, -0.9, 0.3])).toBeCloseTo(0.9);
    expect(peakOf([])).toBe(0);
  });
});

describe('vadStep', () => {
  it('flips to speaking above the RMS threshold', () => {
    const s = vadStep(newVadState(0), LOUD, 0, 20);
    expect(s.speaking).toBe(true);
    expect(s.silenceStartedAt).toBe(0);
  });

  it('counts a sharp peak as speech even when RMS is below threshold', () => {
    const s = vadStep(newVadState(0), QUIET, VAD_PEAK_THRESHOLD * 1.1, 20);
    expect(s.speaking).toBe(true);
  });

  it('accumulates only the loud elapsed time', () => {
    let s = run(newVadState(0), LOUD, 500, 0);
    expect(s.speechMs).toBeCloseTo(500, -1);
    s = run(s, QUIET, 500, 500);
    expect(s.speechMs).toBeCloseTo(500, -1);
  });

  it('starts the silence clock on the first quiet sample and holds it', () => {
    const spoke = run(newVadState(0), LOUD, 200, 0);
    const quiet = vadStep(spoke, QUIET, 0, 220);
    expect(quiet.silenceStartedAt).toBe(220);
    const stillQuiet = vadStep(quiet, QUIET, 0, 400);
    expect(stillQuiet.silenceStartedAt).toBe(220);
  });

  it('resets the silence clock when speech resumes', () => {
    const quiet = run(newVadState(0), QUIET, 400, 0);
    expect(quiet.silenceStartedAt).toBeGreaterThan(0);
    expect(vadStep(quiet, LOUD, 0, 420).silenceStartedAt).toBe(0);
  });

  it('clamps a delayed hop so a stalled tab cannot credit the gap as speech', () => {
    // The offscreen doc can be starved for seconds under load; without the clamp
    // one late sample would book the whole stall as speech and defeat the skip.
    const s = vadStep(newVadState(0), LOUD, 0, 60_000);
    expect(s.speechMs).toBe(1000);
  });

  it('ignores a clock that jumps backwards', () => {
    const s = vadStep({ ...newVadState(0), lastAt: 500 }, LOUD, 0, 100);
    expect(s.speechMs).toBe(0);
  });
});

describe('silenceMs', () => {
  it('is 0 while speaking', () => {
    const s = run(newVadState(0), LOUD, 200, 0);
    expect(silenceMs(s, 500)).toBe(0);
  });

  it('measures from the first quiet sample', () => {
    const s = vadStep(run(newVadState(0), LOUD, 200, 0), QUIET, 0, 220);
    expect(silenceMs(s, 1220)).toBe(1000);
  });
});

describe('shouldRotate', () => {
  it('cuts at a pause once the segment is long enough to be worth a request', () => {
    expect(shouldRotate({ segmentMs: LIVE_SEGMENT_MIN_MS, silenceMs: VAD_SILENCE_MS })).toBe(true);
  });

  it('refuses to cut a short segment, however long the pause', () => {
    // This is the cost gate: one call per utterance would be hundreds an hour.
    expect(shouldRotate({ segmentMs: LIVE_SEGMENT_MIN_MS - 1, silenceMs: 30_000 })).toBe(false);
  });

  it('refuses to cut mid-sentence even in a long segment', () => {
    expect(
      shouldRotate({ segmentMs: LIVE_SEGMENT_MAX_MS - 1, silenceMs: VAD_SILENCE_MS - 1 }),
    ).toBe(false);
  });

  it('cuts at the ceiling regardless of silence — audio that never goes quiet', () => {
    expect(shouldRotate({ segmentMs: LIVE_SEGMENT_MAX_MS, silenceMs: 0 })).toBe(true);
  });
});

describe('hadSpeech', () => {
  it('is false for a segment of pure silence', () => {
    expect(hadSpeech(run(newVadState(0), QUIET, 30_000, 0))).toBe(false);
  });

  it('is true once past the minimum', () => {
    expect(hadSpeech({ ...newVadState(0), speechMs: VAD_MIN_SPEECH_MS })).toBe(true);
    expect(hadSpeech({ ...newVadState(0), speechMs: VAD_MIN_SPEECH_MS - 1 })).toBe(false);
  });

  it('rejects a stray click in an otherwise silent segment', () => {
    // A single loud hop is a chair creak, not a sentence worth an API call.
    const s = vadStep(run(newVadState(0), QUIET, 10_000, 0), LOUD, 0, 10_020);
    expect(hadSpeech(s)).toBe(false);
  });
});
