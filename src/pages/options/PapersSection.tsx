import { useState } from 'react';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { fetchPaperMeta } from '../../shared/papers';
import { DEFAULT_SETTINGS, patchSettings } from '../../shared/storage';

// A well-known paper (Attention Is All You Need) used only to validate the key.
const TEST_REF = 'https://arxiv.org/abs/1706.03762';

type Test = { state: 'idle' } | { state: 'testing' } | { state: 'ok' } | { state: 'error'; message: string };

export function PapersSection() {
  const [stored] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  const hasKey = settings.semanticScholarApiKey.length > 0;
  const [keyInput, setKeyInput] = useState('');
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<Test>({ state: 'idle' });

  // Test the freshly typed key if present, otherwise the saved one
  const keyToTest = keyInput.trim() || settings.semanticScholarApiKey;

  const save = async () => {
    if (!keyInput.trim()) return;
    await patchSettings({ semanticScholarApiKey: keyInput.trim() });
    setKeyInput('');
    setSaved(true);
    setTest({ state: 'idle' });
  };

  const removeKey = async () => {
    await patchSettings({ semanticScholarApiKey: '' });
    setSaved(false);
    setTest({ state: 'idle' });
  };

  const runTest = async () => {
    if (!keyToTest) return;
    setTest({ state: 'testing' });
    const res = await fetchPaperMeta(TEST_REF, keyToTest);
    setTest(res.ok ? { state: 'ok' } : { state: 'error', message: res.message });
  };

  return (
    <section className="section">
      <h2>Research Papers</h2>
      <p className="hint">
        The paper tracker fetches metadata (title, authors, venue, citations, abstract) from the
        Semantic Scholar API. It works without a key, but unauthenticated requests are rate-limited.
        Get a free key at semanticscholar.org/product/api and paste it here for reliable lookups.
      </p>

      <form
        className="add-feed-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          type="password"
          value={keyInput}
          onChange={(e) => {
            setKeyInput(e.target.value);
            setSaved(false);
            setTest({ state: 'idle' });
          }}
          placeholder={hasKey ? 'Key saved — paste to replace' : 'Paste your Semantic Scholar API key'}
        />
        <button type="submit" disabled={!keyInput.trim()}>
          Save key
        </button>
      </form>

      {saved && <p className="feedback success">API key saved.</p>}

      {(hasKey || keyInput.trim()) && (
        <div className="button-group" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="secondary-btn"
            disabled={!keyToTest || test.state === 'testing'}
            onClick={() => void runTest()}
          >
            {test.state === 'testing' ? 'Testing…' : 'Test key'}
          </button>
          {hasKey && (
            <button type="button" className="secondary-btn" onClick={() => void removeKey()}>
              Remove key
            </button>
          )}
        </div>
      )}

      {test.state === 'testing' && <p className="feedback loading">Checking the key…</p>}
      {test.state === 'ok' && <p className="feedback success">Key works ✔ — lookups are authenticated.</p>}
      {test.state === 'error' && <p className="feedback error">{test.message}</p>}
    </section>
  );
}
