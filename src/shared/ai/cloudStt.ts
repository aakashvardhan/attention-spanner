import { VAD_POLL_MS } from '../constants';
import { silenceMs } from './vad';
import {
  RECORDER_MIME,
  UPLOAD_MIME,
  isPermissionError,
  micStream,
  toBase64,
} from './audio';
import type { SttEngine, SttHandlers } from './stt';
import { transcribeSegment } from './transcribe';
import { hadSpeech, newVadState, peakOf, rmsOf, vadStep, type VadState } from './vad';

/**
 * SttEngine for browsers with no Web Speech API — record, then transcribe.
 *
 * Brave removes SpeechRecognition because it ships microphone audio to Google.
 * This replaces it with a round trip the user has already opted into: the same
 * Gemini transcription that lecture and meeting recordings use. Not a secret
 * downgrade — sttAvailability() reports `cloud: true` so the surface can say so.
 *
 * There are no interim results. Nothing exists to stream: the audio is captured
 * whole and transcribed once, which is why SttHandlers.onInterim is optional.
 *
 * A VAD runs alongside the recorder for one reason — to refuse to upload
 * silence. Tapping the mic button and saying nothing would otherwise cost a
 * Gemini call to be told there was no speech, which is the same waste vad.ts
 * was written to avoid on the recording path.
 */

export interface CloudSttOptions {
  /**
   * End the capture automatically after this much silence *following speech*.
   *
   * Push-to-talk does not need it — the button release is the endpoint. The
   * wake word does: nothing is held down, so without a self-endpoint the
   * capture would run until its hard cap on every command.
   */
  autoStopSilenceMs?: number;
}

export function createCloudStt(options: CloudSttOptions = {}): SttEngine {
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let vadBuf: Float32Array | null = null;
  let vad: VadState = newVadState(0);
  let vadTimer: ReturnType<typeof setInterval> | undefined;
  let chunks: Blob[] = [];
  let handlers: SttHandlers | null = null;
  let discarded = false;

  const teardown = () => {
    clearInterval(vadTimer);
    vadTimer = undefined;
    analyser = null;
    vadBuf = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    void ctx?.close().catch(() => undefined);
    ctx = null;
    recorder = null;
  };

  /** Settle exactly once, tearing down whatever is still open */
  const finish = (run: (h: SttHandlers) => void | Promise<void>) => {
    const h = handlers;
    handlers = null;
    teardown();
    if (!h) return;
    void (async () => {
      try {
        await run(h);
      } finally {
        h.onEnd();
      }
    })();
  };

  const onRecorderStop = () => {
    const blob = new Blob(chunks, { type: UPLOAD_MIME });
    chunks = [];
    if (discarded) {
      finish(() => undefined);
      return;
    }
    // Checked before the upload, not after: this is the whole point of the VAD
    const spoke = hadSpeech(vad);
    finish(async (h) => {
      if (!spoke || blob.size === 0) {
        h.onError('no-speech');
        return;
      }
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const text = await transcribeSegment({
          dataBase64: toBase64(bytes),
          mimeType: UPLOAD_MIME,
        });
        const trimmed = text.trim();
        if (trimmed) h.onFinal(trimmed);
        else h.onError('no-speech');
      } catch {
        h.onError('network');
      }
    });
  };

  const pollVad = () => {
    if (!analyser || !vadBuf) return;
    const now = Date.now();
    analyser.getFloatTimeDomainData(vadBuf);
    vad = vadStep(vad, rmsOf(vadBuf), peakOf(vadBuf), now);
    const quiet = options.autoStopSilenceMs;
    // Only after something was actually said — otherwise a command that starts
    // with a pause would be cut off before it began.
    if (quiet !== undefined && hadSpeech(vad) && silenceMs(vad, now) >= quiet) {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    }
  };

  return {
    start(h) {
      if (recorder || handlers) return;
      handlers = h;
      discarded = false;
      chunks = [];
      vad = newVadState(Date.now());
      void (async () => {
        try {
          stream = await micStream();
        } catch (error) {
          finish((hh) => hh.onError(isPermissionError(error) ? 'denied' : 'other'));
          return;
        }
        // start() may have been abandoned while getUserMedia was pending
        if (!handlers) {
          teardown();
          return;
        }
        ctx = new AudioContext();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        ctx.createMediaStreamSource(stream).connect(analyser);
        vadBuf = new Float32Array(analyser.fftSize);
        vad = newVadState(Date.now());
        vadTimer = setInterval(pollVad, VAD_POLL_MS);

        const mimeType = MediaRecorder.isTypeSupported(RECORDER_MIME) ? RECORDER_MIME : '';
        const next = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        next.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        next.onstop = onRecorderStop;
        next.start();
        recorder = next;
      })();
    },
    stop() {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      else if (handlers) finish((h) => h.onError('no-speech'));
    },
    abort() {
      discarded = true;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      else if (handlers) finish(() => undefined);
    },
  };
}
