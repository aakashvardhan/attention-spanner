import { describe, expect, it } from 'vitest';
import {
  WAKE_CHUNK_SAMPLES,
  WAKE_EMBEDDING_WINDOW,
  WAKE_MEL_CONTEXT_SAMPLES,
  WAKE_MEL_STRIDE,
  WAKE_MEL_WINDOW,
  WAKE_REFRACTORY_MS,
  WAKE_SCORE_THRESHOLD,
} from '../constants';
import {
  canScore,
  gateStep,
  melTransform,
  newGateState,
  nextContext,
  pendingMelWindows,
  toInt16Scale,
  trimMelBuffer,
  withContext,
} from './wakeDetector';

describe('melTransform', () => {
  it('applies openWakeWord’s normalization', () => {
    expect(melTransform(0)).toBe(2);
    expect(melTransform(10)).toBe(3);
    expect(melTransform(-20)).toBe(0);
  });
});

describe('pendingMelWindows', () => {
  it('yields nothing until a full window has accumulated', () => {
    expect(pendingMelWindows(0, 0)).toBe(0);
    expect(pendingMelWindows(WAKE_MEL_WINDOW - 1, 0)).toBe(0);
  });

  it('yields the first window exactly at the window size', () => {
    expect(pendingMelWindows(WAKE_MEL_WINDOW, 0)).toBe(1);
  });

  /* One 80ms chunk is one stride, so steady-state is one new window per chunk —
     if this drifts, the detector silently scores stale audio. */
  it('yields one more window per stride of new frames', () => {
    expect(pendingMelWindows(WAKE_MEL_WINDOW + WAKE_MEL_STRIDE, 0)).toBe(2);
    expect(pendingMelWindows(WAKE_MEL_WINDOW + WAKE_MEL_STRIDE * 3, 0)).toBe(4);
  });

  it('does not re-offer windows already consumed', () => {
    const frames = WAKE_MEL_WINDOW + WAKE_MEL_STRIDE * 3;
    expect(pendingMelWindows(frames, WAKE_MEL_STRIDE * 3)).toBe(1);
    expect(pendingMelWindows(frames, WAKE_MEL_STRIDE * 4)).toBe(0);
  });

  it('does not go negative when more is consumed than available', () => {
    expect(pendingMelWindows(WAKE_MEL_WINDOW, WAKE_MEL_STRIDE * 10)).toBe(0);
  });
});

describe('canScore', () => {
  it('needs a full embedding window', () => {
    expect(canScore(WAKE_EMBEDDING_WINDOW - 1)).toBe(false);
    expect(canScore(WAKE_EMBEDDING_WINDOW)).toBe(true);
  });
});

describe('toInt16Scale', () => {
  /* The bug this prevents is invisible: feed [-1,1] and the mel model sees
     near-silence, so the detector simply never fires. */
  it('scales browser floats up to the magnitudes the model was trained on', () => {
    const out = toInt16Scale(new Float32Array([0, 1, -1, 0.5]));
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(32767, 0);
    expect(out[2]).toBeCloseTo(-32767, 0);
    expect(out[3]).toBeCloseTo(16383.5, 0);
  });

  it('preserves length', () => {
    expect(toInt16Scale(new Float32Array(1280)).length).toBe(1280);
  });
});

describe('mel context', () => {
  /* Verified against the real melspectrogram.onnx: 1280 samples alone yield 5
     mel frames, 1280 + 480 yield exactly the 8 the embedder advances by. With
     the buffer filling at 5/8 the rate it drains, the detector runs, scores,
     and never once fires. */
  it('feeds the model a full stride worth of samples', () => {
    const tail = new Float32Array(WAKE_MEL_CONTEXT_SAMPLES);
    const chunk = new Float32Array(WAKE_CHUNK_SAMPLES);
    expect(withContext(tail, chunk).length).toBe(WAKE_CHUNK_SAMPLES + WAKE_MEL_CONTEXT_SAMPLES);
  });

  it('places the tail before the new chunk, in order', () => {
    const out = withContext(new Float32Array([1, 2]), new Float32Array([3, 4, 5]));
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it('carries exactly the trailing samples into the next step', () => {
    const chunk = new Float32Array(WAKE_CHUNK_SAMPLES);
    chunk[WAKE_CHUNK_SAMPLES - 1] = 0.5;
    const next = nextContext(chunk);
    expect(next.length).toBe(WAKE_MEL_CONTEXT_SAMPLES);
    expect(next[next.length - 1]).toBe(0.5);
  });

  it('does not overrun a chunk shorter than the context', () => {
    expect(nextContext(new Float32Array(100)).length).toBe(100);
  });
});

describe('trimMelBuffer', () => {
  it('drops the consumed prefix and resets the cursor', () => {
    expect(trimMelBuffer(160, 76)).toEqual({ length: 84, consumed: 0 });
  });

  it('leaves an untouched buffer alone', () => {
    expect(trimMelBuffer(40, 0)).toEqual({ length: 40, consumed: 0 });
  });

  /* The regression. Each step appends one stride and consumes one, so a
     keep-the-tail rule never fires and the buffer grows by 8 rows every 80ms
     for the life of an always-on listener. Driven here for far longer than any
     tail-based bound would survive. */
  it('stays flat over a long run instead of growing every step', () => {
    let length = 0;
    let consumed = 0;
    const seen: number[] = [];
    for (let step = 0; step < 5000; step++) {
      length += WAKE_MEL_STRIDE;
      let windows = pendingMelWindows(length, consumed);
      while (windows > 0) {
        consumed += WAKE_MEL_STRIDE;
        windows -= 1;
      }
      ({ length, consumed } = trimMelBuffer(length, consumed));
      seen.push(length);
    }
    // Bounded by one window plus a stride, no matter how long it runs
    expect(Math.max(...seen)).toBeLessThanOrEqual(WAKE_MEL_WINDOW + WAKE_MEL_STRIDE);
    expect(seen[seen.length - 1]).toBe(seen[seen.length - 2]);
  });
});

describe('gateStep', () => {
  const under = WAKE_SCORE_THRESHOLD - 0.01;
  const over = WAKE_SCORE_THRESHOLD + 0.01;

  it('does not fire below the threshold', () => {
    const { fired } = gateStep(newGateState(), under, 1000);
    expect(fired).toBe(false);
  });

  it('fires the first time the threshold is crossed', () => {
    const { fired, state } = gateStep(newGateState(), over, 1000);
    expect(fired).toBe(true);
    expect(state.firedAt).toBe(1000);
  });

  /* One utterance spans several overlapping windows, so the raw score crosses
     the threshold repeatedly. Without this the listener would wake, begin
     capturing, and immediately wake again mid-capture. */
  it('suppresses repeat detections inside the refractory period', () => {
    const first = gateStep(newGateState(), over, 1000);
    const second = gateStep(first.state, over, 1000 + WAKE_REFRACTORY_MS - 1);
    expect(second.fired).toBe(false);
    expect(second.state.firedAt).toBe(1000);
  });

  it('fires again once the refractory period has passed', () => {
    const first = gateStep(newGateState(), over, 1000);
    const second = gateStep(first.state, over, 1000 + WAKE_REFRACTORY_MS);
    expect(second.fired).toBe(true);
    expect(second.state.firedAt).toBe(1000 + WAKE_REFRACTORY_MS);
  });

  it('leaves the state untouched when it does not fire', () => {
    const state = newGateState();
    const result = gateStep(state, under, 5000);
    expect(result.state).toBe(state);
  });

  it('honours caller-supplied threshold and refractory period', () => {
    const strict = gateStep(newGateState(), 0.6, 1000, 0.9);
    expect(strict.fired).toBe(false);
    const loose = gateStep(newGateState(), 0.6, 1000, 0.5);
    expect(loose.fired).toBe(true);
  });
});
