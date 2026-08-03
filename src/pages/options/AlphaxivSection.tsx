import { useState } from 'react';
import { summarizeLibrary } from '../../shared/alphaxiv';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { sendMessage } from '../../shared/messages';
import { setLocal } from '../../shared/storage';

/**
 * alphaXiv connection. Nothing to configure — the extension registers itself
 * with alphaXiv's OAuth server on first connect (see docs/alphaxiv-setup.md),
 * so this is only a sign-in button and a smoke test.
 */
export function AlphaxivSection() {
  const [alphaxiv] = useStorageValue('alphaxiv');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const [clientIdInput, setClientIdInput] = useState('');

  const connect = async () => {
    setBusy(true);
    setError(null);
    setTest(null);
    const res = await sendMessage({ type: 'AX_CONNECT' });
    if (!res.ok) setError(res.error ?? 'alphaXiv sign-in failed.');
    setBusy(false);
  };

  const disconnect = async () => {
    setBusy(true);
    await sendMessage({ type: 'AX_DISCONNECT' });
    setError(null);
    setTest(null);
    setBusy(false);
  };

  /**
   * Escape hatch for a registration that alphaXiv refuses (origin policy, rate
   * limit). `connect()` skips registering whenever a client id is already
   * stored, so pasting one here is enough to get past it.
   */
  const saveClientId = async () => {
    const clientId = clientIdInput.trim();
    if (!clientId) return;
    await setLocal({ alphaxiv: { ...alphaxiv, clientId, lastError: '' } });
    setClientIdInput('');
    setError(null);
  };

  const clearClientId = async () => {
    await setLocal({ alphaxiv: { ...alphaxiv, clientId: '', lastError: '' } });
    setClientIdInput('');
    setError(null);
  };

  const runTest = async () => {
    setBusy(true);
    setError(null);
    const res = await sendMessage({ type: 'AX_LIBRARY' });
    if (res.ok) setTest(summarizeLibrary(res.text ?? ''));
    else setError(res.error ?? 'Could not reach alphaXiv.');
    setBusy(false);
  };

  return (
    <section className="section">
      <h2>alphaXiv</h2>

      {!alphaxiv.connected ? (
        <>
          <p className="hint">
            Connect alphaXiv to search the arXiv corpus by topic from the papers page, ask questions
            about a paper with page-level citations in the reader, and let Jarvis find and read
            papers. Sign-in happens in a browser window; the tokens stay on this device.
          </p>
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => void connect()}>
            {busy ? 'Connecting…' : 'Connect alphaXiv'}
          </button>

          <p className="hint" style={{ marginTop: 16 }}>
            Sign-up refused? alphaXiv registers this install automatically, but if it declines you
            can paste a client id minted by hand (see docs/alphaxiv-setup.md) and connect with
            that instead.
          </p>
          <form
            className="add-feed-form"
            onSubmit={(e) => {
              e.preventDefault();
              void saveClientId();
            }}
          >
            <input
              value={clientIdInput}
              autoComplete="off"
              placeholder={alphaxiv.clientId ? 'Client id saved — paste to replace' : 'Paste a client_id'}
              onChange={(e) => setClientIdInput(e.target.value)}
            />
            <button type="submit" disabled={busy || !clientIdInput.trim()}>
              Save client id
            </button>
            {alphaxiv.clientId !== '' && (
              <button
                type="button"
                className="secondary-btn"
                disabled={busy}
                onClick={() => void clearClientId()}
              >
                Clear
              </button>
            )}
          </form>
        </>
      ) : (
        <>
          <div className="setting-row">
            <label>Connected account</label>
            <span>{alphaxiv.email || 'alphaXiv account'}</span>
          </div>
          <p className="hint">
            Papers you add to a deck are also saved to a matching alphaXiv folder, and changing a
            paper's status moves it between Want to read / Reading / Completed. Deleting a paper
            here never deletes it from alphaXiv.
          </p>
          <div className="button-group" style={{ marginTop: 10 }}>
            <button type="button" className="secondary-btn" disabled={busy} onClick={() => void runTest()}>
              {busy ? 'Checking…' : 'Test connection'}
            </button>
            <button type="button" className="secondary-btn" disabled={busy} onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
        </>
      )}

      {test && <p className="feedback success">{test}</p>}
      {(error ?? alphaxiv.lastError) && (
        <p className="feedback error">{error ?? alphaxiv.lastError}</p>
      )}
    </section>
  );
}
