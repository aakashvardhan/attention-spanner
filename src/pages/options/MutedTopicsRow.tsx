import { useState } from 'react';
import { normalizeTopics } from '../../shared/llm/triage';
import { patchSettings } from '../../shared/storage';

/**
 * One topic per line, saved on blur like the other rows here (the new tab
 * re-ranks on every write). The saved list wins if it changes underneath.
 */
export function MutedTopicsRow({ value }: { value: string[] }) {
  const joined = value.join('\n');
  const [draft, setDraft] = useState(joined);
  const [syncedTo, setSyncedTo] = useState(joined);
  if (joined !== syncedTo) {
    setSyncedTo(joined);
    setDraft(joined);
  }

  return (
    <div className="setting-row setting-row-stacked">
      <label htmlFor="muted-topics">Hide from your feeds</label>
      <textarea
        id="muted-topics"
        rows={4}
        value={draft}
        placeholder={'One topic per line, like\nsports\nelection'}
        aria-describedby="muted-topics-hint"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = normalizeTopics(draft);
          setDraft(next.join('\n'));
          if (next.join('\n') !== joined) void patchSettings({ mutedTopics: next });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setDraft(joined);
        }}
      />
      <p id="muted-topics-hint" className="hint">
        Whole words, any case. A feed's name works too, to hide everything from it.
      </p>
    </div>
  );
}
