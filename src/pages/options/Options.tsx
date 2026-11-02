import { useState } from 'react';
import { normalizeBlockDomain } from '../../shared/focusRules';
import { useSettings } from '../../shared/hooks/useSettings';
import { useTheme } from '../../shared/hooks/useTheme';
import { patchSettings } from '../../shared/storage';
import type { ThemeSetting } from '../../shared/types';
import { SectionIndex } from './SectionIndex';

export function Options() {
  useTheme();
  const [settings, settingsLoaded] = useSettings();
  const [blockInput, setBlockInput] = useState('');
  const [blockFeedback, setBlockFeedback] = useState<string | null>(null);

  const addBlockDomain = async () => {
    const domain = normalizeBlockDomain(blockInput);
    if (!domain) {
      setBlockFeedback('Not a valid domain (e.g. netflix.com).');
      return;
    }
    if (settings.focusBlocklist.includes(domain)) {
      setBlockFeedback('Already on the list.');
      return;
    }
    setBlockInput('');
    setBlockFeedback(null);
    await patchSettings({ focusBlocklist: [...settings.focusBlocklist, domain] });
  };

  const removeBlockDomain = (domain: string) =>
    patchSettings({ focusBlocklist: settings.focusBlocklist.filter((d) => d !== domain) });

  if (!settingsLoaded) return null;

  return (
    <div className="colophon grid">
      <header className="colophon-masthead">
        <h1>Settings</h1>
      </header>

      <SectionIndex />

      <main className="colophon-main">
        <section className="section" id="appearance">
          <h2>Appearance</h2>
          <div className="setting-row">
            <label htmlFor="theme-select">Theme</label>
            <select
              id="theme-select"
              value={settings.theme}
              onChange={(e) => void patchSettings({ theme: e.target.value as ThemeSetting })}
            >
              <option value="system">Match system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="paperwhite">Paperwhite</option>
            </select>
          </div>
        </section>

        <section className="section" id="reader">
          <h2>Reader</h2>
          <div className="setting-row">
            <label htmlFor="focus-line">
              Focus line{' '}
              <span className="hint-inline">(dim everything but the passage you are reading; F toggles it)</span>
            </label>
            <input
              id="focus-line"
              type="checkbox"
              checked={settings.readerFocusLine}
              onChange={(e) => void patchSettings({ readerFocusLine: e.target.checked })}
            />
          </div>
        </section>

        <section className="section" id="questions">
          <h2>Questions</h2>
          <p className="hint">
            alphaXiv finds the passages; Claude Haiku writes the questions, checks your explanations and defines terms.
            It never explains the paper to you.
          </p>
          <TextRow
            id="claude-key"
            label="Anthropic API key"
            placeholder="sk-ant-…"
            type="password"
            value={settings.claudeKey}
            onCommit={(claudeKey) => void patchSettings({ claudeKey })}
          />
        </section>

        <section className="section" id="reading-session">
          <h2>Reading session</h2>
          <p className="hint">While a paper is open in the reader, these sites are blocked:</p>
          <form
            className="add-feed-form"
            onSubmit={(e) => {
              e.preventDefault();
              void addBlockDomain();
            }}
          >
            <input
              type="text"
              aria-label="Domain to block"
              value={blockInput}
              onChange={(e) => setBlockInput(e.target.value)}
              placeholder="Add a domain to block (e.g. netflix.com)"
            />
            <button type="submit">Add</button>
          </form>
          {blockFeedback && (
            <p className="feedback error" role="alert">
              {blockFeedback}
            </p>
          )}
          <ul className="feeds-list">
            {settings.focusBlocklist.map((domain) => (
              <li className="feed-entry" key={domain}>
                <span className="feed-entry-url">{domain}</span>
                <button
                  type="button"
                  className="remove-feed-btn"
                  aria-label={`Unblock ${domain}`}
                  onClick={() => void removeBlockDomain(domain)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

/** A text setting saved on blur or Enter; Escape restores the saved value. */
function TextRow({
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
  // The saved value wins if it changes underneath the field (another Settings tab).
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
