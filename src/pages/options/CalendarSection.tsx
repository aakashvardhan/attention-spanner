import { useState } from 'react';
import { hasCalendarCredentials } from '../../shared/calendar';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { formatRelativeDate } from '../../shared/format';
import { sendMessage } from '../../shared/messages';
import { DEFAULT_SETTINGS, patchSettings, setLocal } from '../../shared/storage';

/**
 * Google Calendar connection. The OAuth client is the user's own (nothing is
 * baked into the build), so this section carries the setup too: the redirect
 * URL to register, and the id/secret to paste back. See
 * docs/google-calendar-setup.md.
 */
export function CalendarSection() {
  const [calendar] = useStorageValue('calendar');
  const [stored] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientIdInput, setClientIdInput] = useState('');
  const [clientSecretInput, setClientSecretInput] = useState('');

  const configured = hasCalendarCredentials(calendar);
  // Whatever this install's id happens to be — that's the whole point of not
  // pinning it to an OAuth client any more.
  const redirectUri = chrome.identity.getRedirectURL();

  const saveCredentials = async () => {
    const clientId = clientIdInput.trim();
    const clientSecret = clientSecretInput.trim();
    if (!clientId || !clientSecret) return;
    await setLocal({ calendar: { ...calendar, clientId, clientSecret, lastError: '' } });
    setClientIdInput('');
    setClientSecretInput('');
    setError(null);
  };

  const clearCredentials = async () => {
    await sendMessage({ type: 'CAL_SIGN_OUT' });
    await setLocal({ calendar: { ...calendar, clientId: '', clientSecret: '', lastError: '' } });
    setError(null);
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    const res = await sendMessage({ type: 'CAL_SIGN_IN' });
    if (!res.ok) setError(res.error ?? 'Google sign-in failed.');
    setBusy(false);
  };

  const disconnect = async () => {
    setBusy(true);
    await sendMessage({ type: 'CAL_SIGN_OUT' });
    setError(null);
    setBusy(false);
  };

  const refresh = async () => {
    setBusy(true);
    const res = await sendMessage({ type: 'CAL_REFRESH' });
    setError(res.ok ? null : (res.error ?? 'Refresh failed.'));
    setBusy(false);
  };

  return (
    <section className="section">
      <h2>Google Calendar</h2>

      {!configured ? (
        <>
          <p className="hint">
            Connect your primary Google Calendar to see today's agenda on the dashboard, let the
            assistant answer "when am I free?" and create events, and optionally block focus time on
            your calendar. It runs on an OAuth client you create in your own Google Cloud project —
            follow <code>docs/google-calendar-setup.md</code>, which takes about ten minutes. Tokens
            and credentials stay on this device.
          </p>
          <div className="setting-row">
            <label>Authorized redirect URI</label>
            <code>{redirectUri}</code>
          </div>
          <p className="hint">Register that exact URL on the client, then paste its id and secret:</p>
          <form
            className="add-feed-form"
            onSubmit={(e) => {
              e.preventDefault();
              void saveCredentials();
            }}
          >
            <input
              value={clientIdInput}
              autoComplete="off"
              placeholder="Client ID (…apps.googleusercontent.com)"
              onChange={(e) => setClientIdInput(e.target.value)}
            />
            <input
              type="password"
              value={clientSecretInput}
              autoComplete="off"
              placeholder="Client secret"
              onChange={(e) => setClientSecretInput(e.target.value)}
            />
            <button type="submit" disabled={!clientIdInput.trim() || !clientSecretInput.trim()}>
              Save credentials
            </button>
          </form>
        </>
      ) : !calendar.connected ? (
        <>
          <p className="hint">
            OAuth client saved. Sign in to Google to connect your primary calendar — the tokens stay
            on this device.
          </p>
          <div className="button-group">
            <button type="button" className="secondary-btn" disabled={busy} onClick={() => void connect()}>
              {busy ? 'Connecting…' : 'Connect Google Calendar'}
            </button>
            <button type="button" className="secondary-btn" disabled={busy} onClick={() => void clearCredentials()}>
              Clear credentials
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="setting-row">
            <label>Connected account</label>
            <span>{calendar.email || 'Google account'}</span>
          </div>
          <div className="setting-row">
            <label>Last refreshed</label>
            <span>
              {calendar.fetchedAt > 0 ? formatRelativeDate(new Date(calendar.fetchedAt)) : 'never'}
            </span>
          </div>
          <div className="setting-row">
            <label htmlFor="focus-cal-block">Add a calendar event when a focus session starts</label>
            <input
              id="focus-cal-block"
              type="checkbox"
              checked={settings.focusCalendarBlockEnabled}
              onChange={(e) => void patchSettings({ focusCalendarBlockEnabled: e.target.checked })}
            />
          </div>
          <div className="button-group" style={{ marginTop: 10 }}>
            <button type="button" className="secondary-btn" disabled={busy} onClick={() => void refresh()}>
              Refresh now
            </button>
            <button type="button" className="secondary-btn" disabled={busy} onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
        </>
      )}

      {(error ?? calendar.lastError) && (
        <p className="feedback error">{error ?? calendar.lastError}</p>
      )}
    </section>
  );
}
