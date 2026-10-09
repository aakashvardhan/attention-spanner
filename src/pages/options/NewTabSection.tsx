import { useState } from 'react';
import { normalizeTopics } from '../../shared/llm/triage';
import { patchSettings } from '../../shared/storage';
import type { Settings } from '../../shared/types';

/**
 * The two strings the new tab's hero needs. Both are held as drafts and written
 * on blur rather than on every keystroke: an open new tab subscribes to these
 * through useStorageValue, so a per-character write would geocode "S", "Sa",
 * "San" on its way to a city name.
 */
export function NewTabSection({ settings }: { settings: Settings }) {
  return (
    <section className="section" id="new-tab">
      <h2>New Tab</h2>
      <TextRow
        id="display-name"
        label="Your name"
        placeholder="Leave empty to skip"
        value={settings.displayName}
        onCommit={(displayName) => void patchSettings({ displayName })}
      />
      <TextRow
        id="weather-location"
        label="Weather location"
        placeholder="San Jose"
        value={settings.weatherLocation}
        onCommit={(weatherLocation) => void patchSettings({ weatherLocation })}
      />
      <p className="hint">
        The name greets you on a new tab. The city is looked up once through Open-Meteo, which
        needs no account and no location permission — leave it empty for no weather.
      </p>
      <MutedTopicsRow value={normalizeTopics(settings.mutedTopics)} />
    </section>
  );
}

export function TextRow({
  id,
  label,
  placeholder,
  value,
  onCommit,
  type = 'text',
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onCommit: (value: string) => void;
  type?: 'text' | 'password';
}) {
  const [draft, setDraft] = useState(value);
  // The saved value wins if it changes underneath the field — another Settings
  // tab, or the reset in the Data section.
  const [syncedTo, setSyncedTo] = useState(value);
  if (value !== syncedTo) {
    setSyncedTo(value);
    setDraft(value);
  }

  return (
    <div className="setting-row">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        autoComplete="off"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() !== value && onCommit(draft.trim())}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(value);
        }}
      />
    </div>
  );
}

/**
 * One topic per line, saved on blur like the other rows here (the new tab
 * re-ranks on every write). The saved list wins if it changes underneath.
 */
function MutedTopicsRow({ value }: { value: string[] }) {
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
