import { useEffect, useState } from 'react';
import { formatRelativeDate } from '../../shared/format';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { sendMessage } from '../../shared/messages';

/**
 * Sign in to alphaXiv. The login happens in alphaXiv's own window; the
 * extension only ever holds the token it hands back. Your folders become the
 * shelf; reading progress stays here.
 */
export function AlphaxivSection() {
  const [auth, loaded] = useStorageValue('alphaxivAuth');
  const [status] = useStorageValue('alphaxivStatus');
  const [busy, setBusy] = useState<'signing-in' | 'syncing' | null>(null);
  // "Synced 3m ago" stays true while the page sits open.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const run = async (kind: 'signing-in' | 'syncing', send: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await send();
    } finally {
      setBusy(null);
    }
  };

  // The heading renders before storage loads: the section index reads headings once, at mount.
  return (
    <section className="section" id="alphaxiv">
      <h2>alphaXiv</h2>
      {!loaded ? null : auth ? (
        <>
          <p className="hint">
            Signed in{status.email ? ` as ${status.email}` : ''}. Your alphaXiv folders are your shelves.
          </p>
          <p className="hint" role="status" aria-live="polite">
            {busy === 'syncing'
              ? 'Syncing…'
              : status.lastSyncAt
                ? `Synced ${formatRelativeDate(new Date(status.lastSyncAt)).toLowerCase()}.`
                : 'Not synced yet.'}
          </p>
          <div className="setting-row">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run('syncing', () => sendMessage({ type: 'ALPHAXIV_SYNC', force: true }))}
            >
              Sync now
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void sendMessage({ type: 'ALPHAXIV_SIGN_OUT' })}>
              Sign out
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="hint">
            Sign in with your alphaXiv account. Your folders become your shelves here; progress and where you stopped
            stay in this browser.
          </p>
          <div className="setting-row">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run('signing-in', () => sendMessage({ type: 'ALPHAXIV_SIGN_IN' }))}
            >
              {busy === 'signing-in' ? 'Waiting for alphaXiv…' : 'Sign in to alphaXiv'}
            </button>
          </div>
        </>
      )}
      {loaded && status.error && busy === null && (
        <p className="feedback error" role="alert">
          {status.error}
        </p>
      )}
    </section>
  );
}
