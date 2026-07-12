import { useState } from 'react';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { formatRelativeDate } from '../../shared/format';
import { sendMessage } from '../../shared/messages';
import { DEFAULT_SETTINGS, patchSettings } from '../../shared/storage';

export function CalendarSection() {
  const [calendar] = useStorageValue('calendar');
  const [stored] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = Boolean(chrome.runtime.getManifest().oauth2?.client_id);

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
        <p className="hint">
          Not configured for this build. Follow <code>docs/google-calendar-setup.md</code> to
          create a Google OAuth client and set <code>VITE_CRX_PUBLIC_KEY</code> /{' '}
          <code>VITE_GCAL_CLIENT_ID</code> in <code>.env.local</code>, then rebuild.
        </p>
      ) : !calendar.connected ? (
        <>
          <p className="hint">
            Connect your primary Google Calendar to see today's agenda on the dashboard, let the
            assistant answer "when am I free?" and create events, and optionally block focus time
            on your calendar. Access stays on this device.
          </p>
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => void connect()}>
            {busy ? 'Connecting…' : 'Connect Google Calendar'}
          </button>
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
