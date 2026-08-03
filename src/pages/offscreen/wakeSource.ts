import { gateStep, newGateState, type GateState } from '../../shared/ai/wakeDetector';
import { matchWakeWord } from '../../shared/ai/wakeWord';
import {
  recognitionCtor,
  type SpeechRecognitionLike,
} from '../../shared/ai/webSpeechStt';
import { detectCapabilities } from '../../shared/capabilities';
import { createAudioBus, type AudioBus } from './audioBus';
import { loadWakeDetector } from './wakeModels';

/**
 * "Something said the wake word" — one interface, two ways of noticing.
 *
 * The third of this shape in the codebase, after SpeechBackend (tts.ts) and
 * SttEngine (stt.ts), and for the same reason: the capability differs per
 * browser and the caller should not have to know which one it got.
 *
 * `local` is preferred everywhere, not only where it is the sole option. It
 * runs three small ONNX models on-device, so the microphone stops being a
 * continuous feed to Google's speech service just to notice one word — and it
 * works in Brave, which removes that service precisely because of what it does.
 * The Web Speech source stays as the fallback for a machine where the WASM
 * runtime or the models will not load.
 */

export interface WakeSource {
  /**
   * Begin listening. `onWake` receives any command heard in the same breath —
   * the Web Speech source can hear "hey jarvis, what's on my plan" as one
   * transcript, the local detector only ever knows the word was said.
   */
  start(onWake: (command: string) => void, onError: (kind: 'denied' | 'other') => void): Promise<void>;
  stop(): void;
  /** True while the microphone is held, so the caller can release it for capture */
  running(): boolean;
  readonly kind: 'local' | 'web-speech';
}

/* ---------- on-device: openWakeWord over the audio bus ---------- */

function createLocalWakeSource(): WakeSource {
  let bus: AudioBus | null = null;
  let gate: GateState = newGateState();
  /** Serializes inference: frames arrive every 80ms and must not overlap */
  let busy = false;

  return {
    kind: 'local',
    running: () => bus?.running() ?? false,
    stop() {
      bus?.stop();
      bus = null;
      gate = newGateState();
    },
    async start(onWake, onError) {
      if (bus) return;
      const detector = await loadWakeDetector();
      detector.reset();
      gate = newGateState();
      const next = createAudioBus();
      try {
        await next.start((frame) => {
          // Dropping a frame is correct under load: the detector's own context
          // window makes it resilient to a gap, and queueing would grow without
          // bound on a machine that cannot keep up.
          if (busy) return;
          busy = true;
          void detector
            .push(frame)
            .then((score) => {
              const result = gateStep(gate, score, Date.now());
              gate = result.state;
              if (result.fired) {
                detector.reset();
                onWake('');
              }
            })
            .catch(() => undefined)
            .finally(() => {
              busy = false;
            });
        });
      } catch (error) {
        next.stop();
        const name = (error as { name?: string })?.name ?? '';
        onError(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'other');
        return;
      }
      bus = next;
    },
  };
}

/* ---------- fallback: the browser's own recognizer ---------- */

function createWebSpeechWakeSource(): WakeSource {
  let rec: SpeechRecognitionLike | null = null;
  let stopped = false;

  const spinUp = (
    onWake: (command: string) => void,
    onError: (kind: 'denied' | 'other') => void,
  ) => {
    const Ctor = recognitionCtor();
    if (!Ctor || rec || stopped) return;
    const next = new Ctor();
    next.continuous = true;
    next.interimResults = true;
    next.lang = navigator.language || 'en-US';
    next.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (!result.isFinal) continue;
        const text = result[0].transcript.trim();
        if (!text) continue;
        const command = matchWakeWord(text);
        if (command !== null) onWake(command);
      }
    };
    next.onerror = (e) => {
      // no-speech is the normal end of a quiet stretch, not a failure
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') onError('denied');
    };
    next.onend = () => {
      rec = null;
      // Chrome drops continuous sessions periodically — keep the loop alive
      if (!stopped) spinUp(onWake, onError);
    };
    try {
      next.start();
      rec = next;
    } catch {
      // start() throws if a session is already active
    }
  };

  return {
    kind: 'web-speech',
    running: () => rec !== null,
    stop() {
      stopped = true;
      const current = rec;
      rec = null;
      current?.abort();
    },
    async start(onWake, onError) {
      stopped = false;
      spinUp(onWake, onError);
    },
  };
}

export interface WakeSourceChoice {
  source: WakeSource | null;
  /** Empty when a source was built; otherwise why not, for the log */
  reason: string;
}

/**
 * Pick the best available source. On-device first, the browser's recognizer
 * second, and an explicit reason rather than silence when neither will run —
 * a wake word that fails to nothing is the bug this whole change started from.
 */
export async function pickWakeSource(): Promise<WakeSourceChoice> {
  try {
    // Loading the models is the real test of whether local detection can run;
    // WebAssembly being present says nothing about the CSP allowing it.
    await loadWakeDetector();
    return { source: createLocalWakeSource(), reason: '' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detectCapabilities().webSpeech) {
      console.warn('[wake] on-device detection unavailable, using Web Speech:', detail);
      return { source: createWebSpeechWakeSource(), reason: '' };
    }
    return {
      source: null,
      reason: `on-device detection failed to load (${detail}) and this browser has no Web Speech API`,
    };
  }
}
