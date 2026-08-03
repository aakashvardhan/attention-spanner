import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createSttEngine, sttAvailability, type SttEngine } from '../ai/stt';

/**
 * Push-to-talk speech input. Hold the mic button: pointerdown starts,
 * pointerup stops and fires onFinal.
 *
 * The engine underneath is chosen per browser (see ai/stt.ts) — Chrome's
 * built-in recognizer where it exists, recorded-then-transcribed where it does
 * not. This hook used to construct webkitSpeechRecognition directly, which
 * meant the button silently failed to render in any browser without it.
 *
 * `cloud` is surfaced rather than hidden: with the fallback engine the audio
 * leaves the machine, and a mic button that quietly starts uploading is not a
 * thing to spring on someone.
 */

export function useSpeechInput(handlers: {
  /** Final transcript when the user releases the button (non-empty) */
  onFinal: (text: string) => void;
  /** Live interim transcript while holding. Cloud engine never calls it. */
  onInterim?: (text: string) => void;
  /** Whether a Gemini key is set — the fallback engine cannot run without one */
  hasGeminiKey?: boolean;
}) {
  const { usable, cloud, reason } = useMemo(
    () => sttAvailability(handlers.hasGeminiKey ?? false),
    [handlers.hasGeminiKey],
  );
  const [listening, setListening] = useState(false);
  const [denied, setDenied] = useState(false);
  /** Set while the cloud engine is uploading — there is nothing to hear yet */
  const [transcribing, setTranscribing] = useState(false);
  const engineRef = useRef<SttEngine | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    return () => {
      engineRef.current?.abort();
      engineRef.current = null;
    };
  }, []);

  const start = useCallback(() => {
    if (!usable || engineRef.current) return;
    const engine = createSttEngine();
    engineRef.current = engine;
    setListening(true);
    engine.start({
      onInterim: (text) => handlersRef.current.onInterim?.(text),
      onFinal: (text) => handlersRef.current.onFinal(text),
      onError: (kind) => {
        if (kind === 'denied') setDenied(true);
      },
      onEnd: () => {
        engineRef.current = null;
        setListening(false);
        setTranscribing(false);
      },
    });
  }, [usable]);

  const stop = useCallback(() => {
    if (!engineRef.current) return;
    // The cloud engine's work starts when the button is released, not while it
    // is held; without this the UI looks idle through the whole upload.
    if (cloud) setTranscribing(true);
    setListening(false);
    engineRef.current.stop();
  }, [cloud]);

  return { supported: usable, cloud, reason, listening, transcribing, denied, start, stop };
}
