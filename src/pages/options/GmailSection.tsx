import { useState } from 'react';
import { formatRelativeDate } from '../../shared/format';
import { hasGmailCredentials } from '../../shared/gmail';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { sendMessage } from '../../shared/messages';
import { DEFAULT_SETTINGS, patchSettings, setLocal } from '../../shared/storage';

/**
 * Gmail connections. Same user-owned OAuth client story as Calendar — and it
 * can be the *same* client, from the same Cloud project, with the Gmail API
 * enabled and the two scopes added.
 *
 * The difference is that this connects several mailboxes rather than one, so
 * status and errors are per account: a Workspace tenant that blocks the app
 * shows its refusal on its own row while the other mailbox keeps working.
 * See docs/gmail-setup.md.
 */
export function GmailSection() {
  const [gmail] = useStorageValue('gmail');
  const [stored] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientIdInput, setClientIdInput] = useState('');
  const [clientSecretInput, setClientSecretInput] = useState('');

  const configured = hasGmailCredentials(gmail);
  const redirectUri = chrome.identity.getRedirectURL();

  const saveCredentials = async () => {
    const clientId = clientIdInput.trim();
    const clientSecret = clientSecretInput.trim();
    if (!clientId || !clientSecret) return;
    await setLocal({ gmail: { ...gmail, clientId, clientSecret, lastError: '' } });
    setClientIdInput('');
    setClientSecretInput('');
    setError(null);
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    const res = await sendMessage({ type: 'GMAIL_CONNECT' });
    if (!res.ok) setError(res.error ?? 'Google sign-in failed.');
    setBusy(false);
  };

  const disconnect = async (accountId: string) => {
    setBusy(true);
    await sendMessage({ type: 'GMAIL_DISCONNECT', accountId });
    setError(null);
    setBusy(false);
  };

  const triageNow = async () => {
    setBusy(true);
    const res = await sendMessage({ type: 'GMAIL_TRIAGE', force: true });
    setError(res.ok ? null : res.text);
    setBusy(false);
  };

  return (
    <section className="section">
      <h2>Gmail</h2>

      {!configured ? (
        <>
          <p className="hint">
            Sort your unread mail into <em>today</em>, <em>this week</em>, <em>read only</em> and{' '}
            <em>archive</em> on the dashboard, and let the assistant turn an email into a task. It
            reads sender, subject and Gmail's own one-line snippet — never message bodies — and it
            cannot send or draft anything. Runs on an OAuth client from your own Google Cloud
            project (the same one as Calendar works fine, with the Gmail API enabled); follow{' '}
            <code>docs/gmail-setup.md</code>. Tokens stay on this device.
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
      ) : (
        <>
          {gmail.accounts.length === 0 ? (
            <p className="hint">
              OAuth client saved. Connect each mailbox you want triaged — run this once per address.
            </p>
          ) : (
            <div className="feeds-list">
              {gmail.accounts.map((account) => (
                <div key={account.id} className="feed-entry gmail-account">
                  {/* Its own two-line stack rather than .feed-entry-url, which is
                      a single nowrap line and clips anything put under it */}
                  <div className="gmail-account-main">
                    <span className="gmail-account-email">
                      {account.email || 'Google account'}
                      {!account.connected && (
                        <span className="gmail-account-state"> — disconnected</span>
                      )}
                    </span>
                    {account.lastError && (
                      <span className="gmail-account-error">{account.lastError}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="remove-feed-btn"
                    aria-label={`Disconnect ${account.email || 'account'}`}
                    disabled={busy}
                    onClick={() => void disconnect(account.id)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="button-group" style={{ marginTop: 10 }}>
            <button type="button" className="secondary-btn" disabled={busy} onClick={() => void connect()}>
              {busy
                ? 'Connecting…'
                : gmail.accounts.length === 0
                  ? 'Connect Gmail'
                  : 'Connect another account'}
            </button>
            {gmail.accounts.length > 0 && (
              <button type="button" className="secondary-btn" disabled={busy} onClick={() => void triageNow()}>
                Triage now
              </button>
            )}
          </div>

          {gmail.accounts.length > 0 && (
            <>
              <div className="setting-row" style={{ marginTop: 10 }}>
                <label htmlFor="gmail-triage-time">Triage the inbox daily at</label>
                <input
                  id="gmail-triage-time"
                  type="time"
                  value={settings.gmailTriageTime}
                  onChange={(e) => void patchSettings({ gmailTriageTime: e.target.value })}
                />
              </div>
              <p className="hint">
                Clear the time to turn the scheduled run off; the Refresh button on the Inbox card
                still works. Sorting needs a cloud API key (Settings → Assistant) — without one the
                card lists your unread mail unsorted.
              </p>
              <div className="setting-row">
                <label>Last triaged</label>
                <span>
                  {gmail.triagedAt > 0 ? formatRelativeDate(new Date(gmail.triagedAt)) : 'never'}
                </span>
              </div>
            </>
          )}
        </>
      )}

      {(error ?? gmail.lastError) && <p className="feedback error">{error ?? gmail.lastError}</p>}
    </section>
  );
}
