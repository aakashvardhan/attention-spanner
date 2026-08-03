import { detectCapabilities } from '../capabilities';
import { createCloudStt } from './cloudStt';
import { createWebSpeechStt } from './webSpeechStt';

/**
 * Speech in, the mirror of SpeechBackend in tts.ts.
 *
 * That file already solved this shape for output — extension pages speak with
 * speechSynthesis, the offscreen document cannot and routes through the
 * worker's chrome.tts — and input has exactly the same problem for a different
 * reason. Chrome has the Web Speech API; Brave removed it outright, because it
 * streams microphone audio to Google. One interface, two engines, callers that
 * never learn which one they got.
 *
 * The engines are not equivalent and the interface admits it: `onInterim` is
 * optional because only the streaming engine can produce partial text. A caller
 * that wants live feedback has to degrade gracefully when it never arrives.
 */

export type SttErrorKind =
  /** Microphone permission refused */
  | 'denied'
  /** Recognition service or transcription request unreachable */
  | 'network'
  /** Captured audio held no speech worth transcribing */
  | 'no-speech'
  | 'other';

export interface SttHandlers {
  /** Live partial text. Streaming engines only — never call it required. */
  onInterim?: (text: string) => void;
  /** The transcript. Fires at most once per start()/stop() cycle. */
  onFinal: (text: string) => void;
  onError: (kind: SttErrorKind) => void;
  /** The session is over, however it ended. Always fires exactly once. */
  onEnd: () => void;
}

export interface SttEngine {
  start(handlers: SttHandlers): void;
  /** Finish and transcribe what was captured */
  stop(): void;
  /** Finish and throw it away */
  abort(): void;
}

/** What a surface should tell the user about the engine it is about to use */
export interface SttAvailability {
  usable: boolean;
  /** True when audio is uploaded rather than handled by the browser */
  cloud: boolean;
  /** Empty when usable; otherwise why not, in words a user can act on */
  reason: string;
}

/**
 * Which engine this browser can run, and what it costs the user to use it.
 *
 * The cloud engine is not a free substitute — it needs a Gemini key and it
 * uploads audio — so "no Web Speech" and "no key" are different answers and
 * get different copy.
 */
export function sttAvailability(hasGeminiKey: boolean): SttAvailability {
  const { webSpeech, isBrave } = detectCapabilities();
  if (webSpeech) return { usable: true, cloud: false, reason: '' };
  if (hasGeminiKey) return { usable: true, cloud: true, reason: '' };
  return {
    usable: false,
    cloud: true,
    reason: `${isBrave ? 'Brave' : 'This browser'} has no built-in speech recognition, so voice input needs a Gemini API key to transcribe with.`,
  };
}

/**
 * The best engine this browser can run. Prefer Web Speech wherever it exists:
 * it is free, streams interim text, and keeps the audio out of our own API
 * budget. The cloud engine is the fallback, not the default.
 */
export function createSttEngine(): SttEngine {
  return detectCapabilities().webSpeech ? createWebSpeechStt() : createCloudStt();
}
