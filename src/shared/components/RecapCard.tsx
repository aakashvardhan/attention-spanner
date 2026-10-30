import { useEffect, useRef, useState } from 'react';
import { useAi } from '../hooks/useAi';
import { recapRequest, wantsRecap } from '../llm/recap';
import type { AiSource } from '../llm/route';
import { AiNote } from './AiNote';

/**
 * Shown when a half-read document reopens. Runs once per open, on device
 * unless cloud mode is "all", or "public" with a public source (route.ts).
 */
export function RecapCard({
  progressKey,
  percent,
  passages,
  source,
}: {
  /** readingProgress key, or `paper:<id>` */
  progressKey: string;
  /** Furthest point reached before this open, 0–100 */
  percent: number;
  /** The whole document as passages; null while it is still loading */
  passages: string[] | null;
  source: AiSource;
}) {
  const ai = useAi();
  const { start } = ai;
  const [dismissed, setDismissed] = useState(false);
  const started = useRef(false);
  const eligible = wantsRecap(percent);

  useEffect(() => {
    if (!eligible || !passages || passages.length === 0 || started.current) return;
    started.current = true;
    void start(recapRequest({ key: progressKey, passages, percent, source }));
  }, [start, eligible, passages, percent, progressKey, source]);

  const status = ai.view.status;

  // Nobody asked for this recap, so a missing model is not worth a banner on
  // every open — Settings is where setup is explained.
  if (!eligible || dismissed || status === 'idle' || status === 'unavailable') return null;

  return (
    <aside className="recap-card" aria-label="Where you left off">
      <div className="recap-card-head">
        <h2>Where you left off · {Math.round(percent)}%</h2>
        <button
          type="button"
          className="recap-card-close"
          aria-label="Dismiss recap"
          onClick={() => {
            ai.stop();
            setDismissed(true);
          }}
        >
          ×
        </button>
      </div>
      <AiNote view={ai.view} onStop={ai.stop} onApprove={ai.approve} onDismiss={() => setDismissed(true)} />
    </aside>
  );
}
