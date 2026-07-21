import { useCallback, useEffect, useRef, useState } from 'react';
import { sendMessage } from '../messages';

/**
 * Push-to-talk speech input over webkitSpeechRecognition (Chrome's built-in,
 * server-backed STT — needs network and a one-time mic grant for the
 * extension origin, done from the options page). Hold the mic button:
 * pointerdown starts, pointerup stops and fires onFinal.
 */

/* SpeechRecognition isn't in TS's dom lib yet — minimal local typing */
interface SpeechRecognitionLike {
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

interface SpeechResultEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useSpeechInput(handlers: {
  /** Final transcript when the user releases the button (non-empty) */
  onFinal: (text: string) => void;
  /** Live interim transcript while holding */
  onInterim?: (text: string) => void;
}) {
  const supported = recognitionCtor() !== null;
  const [listening, setListening] = useState(false);
  const [denied, setDenied] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef('');
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => () => recRef.current?.abort(), []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || recRef.current) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    finalRef.current = '';

    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) finalRef.current += result[0].transcript;
        else interim += result[0].transcript;
      }
      handlersRef.current.onInterim?.((finalRef.current + interim).trim());
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setDenied(true);
    };
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
      // Fires on stop, abort, and unmount alike — release the wake-word mic
      void sendMessage({ type: 'WAKE_MIC_BUSY', busy: false }).catch(() => undefined);
      const text = finalRef.current.trim();
      if (text) handlersRef.current.onFinal(text);
    };

    try {
      rec.start();
      recRef.current = rec;
      setListening(true);
      // Pause the always-on "hey Jarvis" listener — two sessions conflict
      void sendMessage({ type: 'WAKE_MIC_BUSY', busy: true }).catch(() => undefined);
    } catch {
      // start() throws if a session is already active — ignore
    }
  }, []);

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  return { supported, listening, denied, start, stop };
}
