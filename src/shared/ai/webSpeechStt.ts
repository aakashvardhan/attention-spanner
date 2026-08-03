import type { SttEngine, SttErrorKind, SttHandlers } from './stt';

/**
 * SttEngine over the browser's own SpeechRecognition — Chrome's built-in,
 * server-backed STT. Free, streaming, and low latency, which is why it stays
 * the preferred engine wherever it exists. It needs network and a one-time mic
 * grant for the extension origin (done from the options page).
 *
 * This is the single definition of the API's shape. It was previously copied
 * into useSpeechInput.ts and wakeListener.ts, which is how two call sites came
 * to disagree about what a `no-speech` error means.
 */

/* SpeechRecognition isn't in TS's dom lib yet — minimal local typing */
export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechResultEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface SpeechResultEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

export function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = globalThis as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Map the API's error strings onto the engine-neutral set. Pure. */
export function classifyError(error: string): SttErrorKind {
  if (error === 'not-allowed' || error === 'service-not-allowed') return 'denied';
  if (error === 'network' || error === 'audio-capture') return 'network';
  if (error === 'no-speech') return 'no-speech';
  return 'other';
}

export function createWebSpeechStt(): SttEngine {
  let rec: SpeechRecognitionLike | null = null;
  let final = '';
  let handlers: SttHandlers | null = null;
  /** Set by abort(), so onend knows to discard rather than emit */
  let discarded = false;

  const finish = () => {
    const h = handlers;
    rec = null;
    handlers = null;
    if (!h) return;
    const text = final.trim();
    if (!discarded && text) h.onFinal(text);
    h.onEnd();
  };

  return {
    start(h) {
      const Ctor = recognitionCtor();
      if (!Ctor || rec) return;
      final = '';
      discarded = false;
      handlers = h;
      const next = new Ctor();
      next.continuous = true;
      next.interimResults = true;
      next.lang = navigator.language || 'en-US';
      next.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const result = e.results[i];
          if (result.isFinal) final += result[0].transcript;
          else interim += result[0].transcript;
        }
        h.onInterim?.((final + interim).trim());
      };
      next.onerror = (e) => h.onError(classifyError(e.error));
      next.onend = finish;
      try {
        next.start();
        rec = next;
      } catch {
        // start() throws if a session is already active
        handlers = null;
        h.onEnd();
      }
    },
    stop() {
      rec?.stop();
    },
    abort() {
      discarded = true;
      rec?.abort();
    },
  };
}
