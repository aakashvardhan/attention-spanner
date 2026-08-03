import {
  WAKE_CHUNK_SAMPLES,
  WAKE_EMBEDDING_WINDOW,
  WAKE_MEL_CONTEXT_SAMPLES,
  WAKE_MEL_STRIDE,
  WAKE_MEL_WINDOW,
  WAKE_REFRACTORY_MS,
  WAKE_SCORE_THRESHOLD,
} from '../constants';

/**
 * "Hey Jarvis", spotted on-device.
 *
 * Three ONNX models in a chain, the openWakeWord pipeline: raw audio becomes a
 * mel spectrogram, 76-frame windows of that become 96-dimensional speech
 * embeddings, and 16 embeddings become one score. Nothing leaves the machine.
 *
 * That last sentence is the point. The wake word previously ran on the Web
 * Speech API, which meant an always-on microphone streaming every sound in the
 * room to Google's servers for the privilege of noticing one word — and it did
 * not run at all in Brave, which removes that API precisely because of what it
 * does. Local detection fixes both at once: it works in any browser that can
 * run WebAssembly, and audio only ever reaches the network *after* the wake
 * word, as the command the user meant to send.
 *
 * As in vad.ts, the decisions live in pure functions and the I/O does not, so
 * the windowing arithmetic and the trigger gate are testable without a
 * microphone, a GPU, or a 13 MB WASM runtime.
 */

/** openWakeWord's own normalization between the mel model and the embedder. */
export function melTransform(value: number): number {
  return value / 10 + 2;
}

/**
 * How many embedding windows a mel buffer can produce that it has not already.
 *
 * The embedder reads WAKE_MEL_WINDOW frames at a time and advances by
 * WAKE_MEL_STRIDE, so a buffer yields a new window only once it has grown a
 * full stride past the last one consumed. Pure.
 */
export function pendingMelWindows(melFrames: number, consumed: number): number {
  const available = melFrames - consumed - WAKE_MEL_WINDOW;
  if (available < 0) return 0;
  return Math.floor(available / WAKE_MEL_STRIDE) + 1;
}

/**
 * The mel buffer after discarding what has already become embeddings.
 *
 * The invariant this exists to pin down: in steady state each step appends one
 * stride and consumes one, so any "keep the last N frames" test is never true
 * and the buffer grows for as long as the listener runs. Dropping the consumed
 * prefix instead keeps it flat. Pure.
 */
export function trimMelBuffer(length: number, consumed: number): { length: number; consumed: number } {
  if (consumed <= 0) return { length, consumed };
  return { length: length - consumed, consumed: 0 };
}

/** Whether enough embeddings have accumulated to score at all. Pure. */
export function canScore(embeddingCount: number): boolean {
  return embeddingCount >= WAKE_EMBEDDING_WINDOW;
}

export interface GateState {
  /** When the last detection fired; 0 means none yet */
  firedAt: number;
}

export function newGateState(): GateState {
  return { firedAt: 0 };
}

/**
 * Should this score trigger the wake word?
 *
 * A single spoken "hey Jarvis" sits inside several overlapping 1.28s windows,
 * so the raw score crosses the threshold repeatedly for one utterance. The
 * refractory period collapses that burst into one event — without it, the
 * listener would wake, start capturing, and immediately wake again mid-capture.
 * Pure: `now` is passed, never read.
 */
export function gateStep(
  state: GateState,
  score: number,
  now: number,
  threshold = WAKE_SCORE_THRESHOLD,
  refractoryMs = WAKE_REFRACTORY_MS,
): { state: GateState; fired: boolean } {
  if (score < threshold) return { state, fired: false };
  if (state.firedAt !== 0 && now - state.firedAt < refractoryMs) return { state, fired: false };
  return { state: { firedAt: now }, fired: true };
}

/**
 * Convert browser float samples to what the mel model was exported for.
 *
 * getUserMedia gives floats in [-1, 1]; openWakeWord trained on int16 PCM and
 * its melspectrogram model expects those magnitudes as floats. Feeding it [-1,
 * 1] directly produces a spectrogram of near-silence and a detector that never
 * fires — silently, which is the failure this whole change exists to stop.
 * Pure.
 */
export function toInt16Scale(samples: Float32Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * 32767;
  return out;
}

/**
 * Prepend the tail of the previous chunk, so the mel model emits a full stride.
 *
 * The window arithmetic is unforgiving: 1280 samples on their own produce 5 mel
 * frames, but the embedder advances 8 per step. Feeding the last
 * WAKE_MEL_CONTEXT_SAMPLES of the preceding chunk makes each step produce
 * exactly 8. Pure — the caller owns the tail.
 */
export function withContext(tail: Float32Array, chunk: Float32Array): Float32Array {
  const out = new Float32Array(tail.length + chunk.length);
  out.set(tail, 0);
  out.set(chunk, tail.length);
  return out;
}

/** The trailing samples to carry into the next step. Pure. */
export function nextContext(chunk: Float32Array): Float32Array {
  return chunk.slice(Math.max(0, chunk.length - WAKE_MEL_CONTEXT_SAMPLES));
}

/* ---------- the part that touches ONNX ---------- */

/** Minimal surface of onnxruntime-web that this file uses. */
interface OrtTensorLike {
  data: Float32Array;
  dims: readonly number[];
}
interface OrtSessionLike {
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
  inputNames: readonly string[];
  outputNames: readonly string[];
}
export interface OrtLike {
  InferenceSession: {
    create(path: string): Promise<OrtSessionLike>;
  };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => OrtTensorLike;
}

export interface WakeDetector {
  /** Feed exactly WAKE_CHUNK_SAMPLES of 16 kHz mono audio. Returns the score. */
  push(chunk: Float32Array): Promise<number>;
  /** Drop accumulated context — after a capture, so stale audio cannot re-fire */
  reset(): void;
}

/**
 * Build the detector over three already-loaded sessions. Taking sessions rather
 * than paths keeps this function free of the runtime's loading strategy, which
 * is the part that differs between the offscreen document and a test.
 */
export function createWakeDetector(
  ort: OrtLike,
  sessions: { mel: OrtSessionLike; embed: OrtSessionLike; wake: OrtSessionLike },
): WakeDetector {
  /** Mel frames, flattened rows of 32 bins */
  let mel: number[][] = [];
  let melConsumed = 0;
  let embeddings: number[][] = [];
  /** Tail of the previous chunk — see withContext */
  let context = new Float32Array(WAKE_MEL_CONTEXT_SAMPLES);

  const reset = () => {
    mel = [];
    melConsumed = 0;
    embeddings = [];
    context = new Float32Array(WAKE_MEL_CONTEXT_SAMPLES);
  };

  return {
    reset,
    async push(chunk) {
      const withTail = withContext(context, chunk);
      context = nextContext(chunk);
      const samples = toInt16Scale(withTail);
      const input = new ort.Tensor('float32', samples, [1, samples.length]);
      const melOut = await sessions.mel.run({ [sessions.mel.inputNames[0]]: input });
      const melData = melOut[sessions.mel.outputNames[0]];
      // [1, 1, frames, 32] — take the trailing two dimensions
      const bins = melData.dims[melData.dims.length - 1];
      const frames = melData.data.length / bins;
      for (let f = 0; f < frames; f++) {
        const row = new Array<number>(bins);
        for (let b = 0; b < bins; b++) row[b] = melTransform(melData.data[f * bins + b]);
        mel.push(row);
      }

      // Every complete 76-frame window that has appeared since the last call
      let windows = pendingMelWindows(mel.length, melConsumed);
      while (windows > 0) {
        const start = melConsumed;
        const flat = new Float32Array(WAKE_MEL_WINDOW * bins);
        for (let f = 0; f < WAKE_MEL_WINDOW; f++) {
          for (let b = 0; b < bins; b++) flat[f * bins + b] = mel[start + f][b];
        }
        const embedIn = new ort.Tensor('float32', flat, [1, WAKE_MEL_WINDOW, bins, 1]);
        const embedOut = await sessions.embed.run({ [sessions.embed.inputNames[0]]: embedIn });
        embeddings.push(Array.from(embedOut[sessions.embed.outputNames[0]].data));
        melConsumed += WAKE_MEL_STRIDE;
        windows -= 1;
      }

      // Drop the frames already turned into embeddings. The next window starts
      // at melConsumed, so nothing before it is ever read again.
      //
      // Not "keep the last N": in steady state each step adds one stride and
      // consumes one, so the unconsumed count is constant and a
      // keep-the-tail test never fires at all — the buffer then grows by 8 rows
      // every 80ms for as long as the listener runs. This is an always-on
      // microphone; it has to be flat, not slowly leaking.
      const trimmed = trimMelBuffer(mel.length, melConsumed);
      if (trimmed.length !== mel.length) mel = mel.slice(melConsumed);
      melConsumed = trimmed.consumed;
      if (embeddings.length > WAKE_EMBEDDING_WINDOW) {
        embeddings = embeddings.slice(embeddings.length - WAKE_EMBEDDING_WINDOW);
      }

      if (!canScore(embeddings.length)) return 0;
      const dim = embeddings[0].length;
      const flat = new Float32Array(WAKE_EMBEDDING_WINDOW * dim);
      for (let i = 0; i < WAKE_EMBEDDING_WINDOW; i++) {
        for (let d = 0; d < dim; d++) flat[i * dim + d] = embeddings[i][d];
      }
      const wakeIn = new ort.Tensor('float32', flat, [1, WAKE_EMBEDDING_WINDOW, dim]);
      const wakeOut = await sessions.wake.run({ [sessions.wake.inputNames[0]]: wakeIn });
      return wakeOut[sessions.wake.outputNames[0]].data[0] ?? 0;
    },
  };
}

export const WAKE_CHUNK = WAKE_CHUNK_SAMPLES;
