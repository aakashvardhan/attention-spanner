import { useCallback, useEffect, useState } from 'react';
import { getAvailability, type AiAvailability } from '../ai/brainDump';

const DOWNLOAD_POLL_MS = 3000;

/**
 * Tracks on-device Gemini Nano availability for the degradation ladder:
 * available → normal; downloadable → "Enable AI" button; downloading →
 * disabled + polling; unavailable → raw-note-only mode.
 */
export function useBrainDumpAI() {
  const [availability, setAvailability] = useState<AiAvailability>('unavailable');
  const [checked, setChecked] = useState(false);

  const refresh = useCallback(async () => {
    setAvailability(await getAvailability());
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

  return { availability, checked, refresh };
}
