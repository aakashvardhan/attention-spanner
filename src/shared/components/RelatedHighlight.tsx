import { useEffect, useRef, useState } from 'react';
import { useSettings } from '../hooks/useSettings';
import { useStorageValue } from '../hooks/useStorageValue';
import { RELATED_MIN_SCORE, recallEntries, searchRecall, type RecallEntry } from '../llm/recall';
import { recordStat } from '../llm/store';

/**
 * After you highlight something, a quiet card if you highlighted something
 * like it in another document — the connection you would otherwise have to
 * remember on your own. Silent when there is no close match or no model.
 */
export function RelatedHighlight({ docKey }: { docKey: string }) {
  const [settings, settingsLoaded] = useSettings();
  const [annotations, annotationsLoaded] = useStorageValue('annotations');
  const [papers] = useStorageValue('papers');
  const [match, setMatch] = useState<RecallEntry | null>(null);

  // Highlights that existed when the page opened are not new. Taken once the
  // stored list has loaded — before that it reads as empty, and everything
  // would look freshly made.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null && annotationsLoaded) {
    seen.current = new Set(annotations.filter((a) => a.docKey === docKey).map((a) => a.id));
  }
  const fresh = seen.current
    ? annotations.find((a) => a.docKey === docKey && a.kind === 'highlight' && a.text && !seen.current!.has(a.id))
    : undefined;

  const live = useRef({ annotations, papers, settings });
  live.current = { annotations, papers, settings };
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);

  const freshId = fresh?.id;
  const freshText = fresh?.text ?? '';
  useEffect(() => {
    if (!freshId || !settingsLoaded) return;
    seen.current!.add(freshId);
    const { annotations, papers, settings } = live.current;
    const others = recallEntries(annotations, papers).filter((e) => e.docKey !== docKey);
    void searchRecall(freshText, others, settings, 1)
      .then(([best]) => {
        if (!mounted.current || !best || best.score < RELATED_MIN_SCORE) return;
        setMatch(best.entry);
        void recordStat({ count: 'related.shown' });
      })
      .catch(() => undefined);
  }, [freshId, freshText, settingsLoaded, docKey]);

  if (!match) return null;
  return (
    <aside className="recap-card related-card" aria-label="Related highlight" aria-live="polite">
      <div className="recap-card-head">
        <h2>You highlighted something similar</h2>
        <button type="button" className="recap-card-close" aria-label="Dismiss" onClick={() => setMatch(null)}>
          ×
        </button>
      </div>
      <p className="related-quote">“{match.quote}”</p>
      <button
        type="button"
        className="ai-note-link"
        onClick={() => {
          void recordStat({ count: 'related.clicked' });
          void chrome.tabs.create({ url: match.url });
        }}
      >
        Open {match.title}
      </button>
    </aside>
  );
}
