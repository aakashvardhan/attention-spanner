import { useCallback, useEffect, useState } from 'react';
import { getEngines, pickDumpEngine, type AiAvailability, type DumpEngines } from '../ai/brainDump';

const DOWNLOAD_POLL_MS = 3000;

/**
 * Tracks on-device Gemini Nano availability for the degradation ladder:
 * available → normal; downloadable → "Enable AI" button; downloading →
 * disabled + polling; unavailable → raw-note-only mode.
 *
 * `engine` folds in the cloud fallback (see brainDump.pickDumpEngine) for the
 * surfaces that can use it; `availability` stays Nano-only for the callers
 * that specifically gate on the on-device model.
 */
export function useBrainDumpAI() {
  const [engines, setEngines] = useState<DumpEngines>({ nano: 'unavailable', cloud: false });
  const [checked, setChecked] = useState(false);
  const availability: AiAvailability = engines.nano;

  const refresh = useCallback(async () => {
    setEngines(await getEngines());
    setChecked(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (availability !== 'downloading') return;
    const timer = setInterval(() => void refresh(), DOWNLOAD_POLL_MS);
    return () => clearInterval(timer);
  }, [availability, refresh]);

  return { availability, engine: pickDumpEngine(engines), checked, refresh };
}
