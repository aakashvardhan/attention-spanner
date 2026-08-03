import {
  LIVE_SEGMENT_MAX_MS,
  LIVE_SEGMENT_MIN_MS,
  VAD_MIN_SPEECH_MS,
  VAD_PEAK_THRESHOLD,
  VAD_RMS_THRESHOLD,
  VAD_SILENCE_MS,
} from '../constants';

/**
 * Voice activity detection: where to cut a recording, and whether the piece we
 * cut was worth transcribing. The mirror of vision.ts — the offscreen recorder
 * owns the AnalyserNode and the clock, this file owns the decisions, which is
 * what makes them testable without a DOM or a microphone.
 *
 * Two jobs, and the second is the one that saves money. Cutting on a pause puts
 * segment boundaries on sentence boundaries instead of on a five-minute timer.
 * But the same signal also tells us a segment held no speech at all, and those
 * can skip transcription entirely: today a silent stretch is sent to Gemini in
 * full, comes back as "No speech detected", and is thrown away by
 * cleanTranscript — we pay for the call and keep nothing.
 */

export interface VadState {
  /** Currently above the speech threshold */
  speaking: boolean;
  /** When the current quiet stretch began; 0 while speaking */
  silenceStartedAt: number;
  /** Total milliseconds of speech accumulated in this segment */
  speechMs: number;
  /** Last sample's timestamp, so a step measures its own elapsed time */
  lastAt: number;
}

export function newVadState(now: number): VadState {
  return { speaking: false, silenceStartedAt: now, speechMs: 0, lastAt: now };
}

/**
 * Root mean square of a time-domain buffer — loudness, in the same 0..1 units
 * as the sample values. Pure.
 */
export function rmsOf(samples: Float32Array | number[]): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Largest absolute sample in the buffer. Pure. */
export function peakOf(samples: Float32Array | number[]): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

/**
 * Advance the detector by one sample. Two thresholds rather than one: RMS
 * averages a consonant away to nothing, so a sharp peak counts as speech even
 * when the window's energy doesn't. Pure — `now` is passed, never read.
 */
export function vadStep(state: VadState, rms: number, peak: number, now: number): VadState {
  const loud = rms >= VAD_RMS_THRESHOLD || peak >= VAD_PEAK_THRESHOLD;
  // Clamped: a hop the browser delayed under load shouldn't credit the gap as
  // speech, and a clock that jumped backwards shouldn't subtract from it.
  const elapsed = Math.max(0, Math.min(now - state.lastAt, 1000));
  return {
    speaking: loud,
    // 0 means "not quiet"; the clock starts on the first quiet sample and runs
    // until the next loud one.
    silenceStartedAt: loud ? 0 : state.silenceStartedAt || now,
    speechMs: loud ? state.speechMs + elapsed : state.speechMs,
    lastAt: now,
  };
}

/** How long the current quiet stretch has run, in ms. 0 while speaking. Pure. */
export function silenceMs(state: VadState, now: number): number {
  if (state.speaking || state.silenceStartedAt === 0) return 0;
  return Math.max(0, now - state.silenceStartedAt);
}

export interface RotateGate {
  /** Milliseconds of audio in the segment so far */
  segmentMs: number;
  /** Milliseconds of continuous quiet right now */
  silenceMs: number;
}

/**
 * Cut here? A pause only ends a segment once the segment is long enough to be
 * worth a request — one call per utterance would be hundreds an hour, which is
 * the cost Pluely absorbs by charging for it. The max is a backstop for audio
 * that never goes quiet. Pure.
 */
export function shouldRotate(gate: RotateGate): boolean {
  if (gate.segmentMs >= LIVE_SEGMENT_MAX_MS) return true;
  return gate.segmentMs >= LIVE_SEGMENT_MIN_MS && gate.silenceMs >= VAD_SILENCE_MS;
}

/**
 * Did this segment hold enough speech to be worth transcribing? The silence-skip
 * predicate: false means discard the audio without a network call. Pure.
 */
export function hadSpeech(state: VadState): boolean {
  return state.speechMs >= VAD_MIN_SPEECH_MS;
}
