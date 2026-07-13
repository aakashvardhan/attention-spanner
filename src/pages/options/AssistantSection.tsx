import { useEffect, useState } from 'react';
import { testGeminiKey } from '../../shared/ai/geminiProvider';
import { listVoices } from '../../shared/ai/tts';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { sendMessage } from '../../shared/messages';
import { DEFAULT_SETTINGS, patchSettings } from '../../shared/storage';

type Test = { state: 'idle' } | { state: 'testing' } | { state: 'ok' } | { state: 'error'; message: string };

type Mic = { state: 'unknown' } | { state: 'granted' } | { state: 'denied' };

export function AssistantSection() {
  const [stored] = useStorageValue('settings');
  const [memory] = useStorageValue('assistantMemory');
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  const hasKey = settings.geminiApiKey.length > 0;
  const [keyInput, setKeyInput] = useState('');
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<Test>({ state: 'idle' });
  const [mic, setMic] = useState<Mic>({ state: 'unknown' });
  const [voices, setVoices] = useState<{ name: string; lang: string }[]>([]);

  useEffect(() => {
    void navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((status) => {
        if (status.state === 'granted') setMic({ state: 'granted' });
        else if (status.state === 'denied') setMic({ state: 'denied' });
      })
      .catch(() => undefined);
    void listVoices().then((list) =>
      setVoices(list.map((v) => ({ name: v.name, lang: v.lang }))),
    );
  }, []);

  const grantMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      setMic({ state: 'granted' });
    } catch {
      setMic({ state: 'denied' });
    }
  };

  const keyToTest = keyInput.trim() || settings.geminiApiKey;

  const save = async () => {
    if (!keyInput.trim()) return;
    await patchSettings({ geminiApiKey: keyInput.trim() });
    setKeyInput('');
    setSaved(true);
    setTest({ state: 'idle' });
  };

  const removeKey = async () => {
    await patchSettings({ geminiApiKey: '' });
    setSaved(false);
    setTest({ state: 'idle' });
  };

  const runTest = async () => {
    if (!keyToTest) return;
    setTest({ state: 'testing' });
    const res = await testGeminiKey(keyToTest);
    setTest(res.ok ? { state: 'ok' } : { state: 'error', message: res.error ?? 'Key test failed.' });
  };

  return (
    <section className="section">
      <h2>Assistant</h2>
      <p className="hint">
        The assistant answers questions about your data and runs actions (add tasks, start focus
        sessions…) from the dashboard. It runs on Chrome's built-in on-device Gemini Nano —
        nothing leaves your machine.
      </p>
      <div className="setting-row">
        <label htmlFor="assistant-enabled">Enable assistant</label>
        <input
          id="assistant-enabled"
          type="checkbox"
          checked={settings.assistantEnabled}
          onChange={(e) => void patchSettings({ assistantEnabled: e.target.checked })}
        />
      </div>

      <p className="hint">
        Optional: a Gemini API key (free tier at aistudio.google.com) lets the assistant handle
        long pages and harder questions in the cloud when the on-device model can't. The key is
        stored locally in this browser only and is never synced.
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
          placeholder={hasKey ? 'Key saved — paste to replace' : 'Paste your Gemini API key'}
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

      {test.state === 'ok' && <p className="feedback success">Key works ✔ — cloud fallback is on.</p>}
      {test.state === 'error' && <p className="feedback error">{test.message}</p>}

      <p className="hint" style={{ marginTop: 16 }}>
        Voice: hold the 🎙 button in the assistant to talk instead of typing (uses Chrome's speech
        recognition, which sends audio to Google), and have replies read aloud.
      </p>
      <div className="setting-row">
        <label>Microphone for voice input</label>
        {mic.state === 'granted' ? (
          <span className="feedback success" style={{ margin: 0 }}>
            Granted ✔
          </span>
        ) : (
          <button type="button" className="secondary-btn" onClick={() => void grantMic()}>
            {mic.state === 'denied' ? 'Blocked — try again' : 'Enable microphone'}
          </button>
        )}
      </div>
      {mic.state === 'denied' && (
        <p className="feedback error">
          Chrome blocked the microphone for this extension. Click the mic icon in the address bar
          (or Site settings) to allow it, then retry.
        </p>
      )}
      <div className="setting-row">
        <label htmlFor="assistant-voice">Speak replies aloud</label>
        <input
          id="assistant-voice"
          type="checkbox"
          checked={settings.assistantVoiceEnabled}
          onChange={(e) => void patchSettings({ assistantVoiceEnabled: e.target.checked })}
        />
      </div>
      {settings.assistantVoiceEnabled && voices.length > 0 && (
        <div className="setting-row">
          <label htmlFor="assistant-tts-voice">Voice</label>
          <select
            id="assistant-tts-voice"
            value={settings.assistantTtsVoice}
            onChange={(e) => void patchSettings({ assistantTtsVoice: e.target.value })}
          >
            <option value="">System default</option>
            {voices.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        </div>
      )}

      <h3 style={{ marginTop: 20 }}>Memory</h3>
      <p className="hint">
        Facts you asked the assistant to remember (“remember I lift Mon/Wed/Fri”). They shape its
        answers and morning briefing, and stay on this device only.
      </p>
      {(memory ?? []).length === 0 ? (
        <p className="empty-message">Nothing remembered yet.</p>
      ) : (
        <>
          <div className="feeds-list">
            {(memory ?? []).map((fact) => (
              <div key={fact.id} className="feed-entry">
                <span className="feed-entry-url" style={{ whiteSpace: 'normal' }}>
                  {fact.text}
                </span>
                <button
                  type="button"
                  className="remove-feed-btn"
                  aria-label={`Forget "${fact.text}"`}
                  onClick={() => void sendMessage({ type: 'MEMORY_DELETE', id: fact.id })}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="secondary-btn"
            style={{ marginTop: 10 }}
            onClick={() =>
              void (async () => {
                // Sequential — parallel deletes would race the worker's read-modify-write
                for (const fact of memory ?? []) {
                  await sendMessage({ type: 'MEMORY_DELETE', id: fact.id });
                }
              })()
            }
          >
            Forget all
          </button>
        </>
      )}
    </section>
  );
}
