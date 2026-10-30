import { useState } from 'react';
import { normalizeTrackTopics } from '../../shared/topics';
import { patchSettings } from '../../shared/storage';

/** One topic per line, saved on blur like MutedTopicsRow. Empty turns the filter off. */
export function TrackTopicsRow({ value }: { value: string[] }) {
  const joined = value.join('\n');
  const [draft, setDraft] = useState(joined);
  const [syncedTo, setSyncedTo] = useState(joined);
  if (joined !== syncedTo) {
    setSyncedTo(joined);
    setDraft(joined);
  }

  return (
    <div className="setting-row setting-row-stacked">
      <label htmlFor="track-topics">Topics to keep in Continue</label>
      <textarea
        id="track-topics"
        rows={4}
        value={draft}
        aria-describedby="track-topics-hint"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = normalizeTrackTopics(draft.split('\n'));
          setDraft(next.join('\n'));
          if (next.join('\n') !== joined) void patchSettings({ trackTopics: next });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setDraft(joined);
        }}
      />
      <p id="track-topics-hint" className="hint">
        One per line. Leave empty to keep everything.
      </p>
    </div>
  );
}
