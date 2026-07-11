import { useState } from 'react';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { isFirebaseConfigured } from '../../shared/firebaseConfig';
import { sendMessage } from '../../shared/messages';

type Feedback = { text: string; kind: 'success' | 'error' | 'loading' } | null;

/**
 * Cloud-sync account controls. Sign-in/up/out are performed in the service
 * worker (single auth + Firestore instance); this UI just sends messages and
 * reads the reactive `sync` state from storage.
 */
export function AccountSection() {
  const [sync] = useStorageValue('sync');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);

  const signedIn = sync.userId !== null;

  const run = async (type: 'SYNC_SIGN_IN' | 'SYNC_SIGN_UP', verb: string) => {
    if (!email.trim() || !password) {
      setFeedback({ text: 'Enter both an email and a password.', kind: 'error' });
      return;
    }
    setFeedback({ text: `${verb}…`, kind: 'loading' });
    try {
      const res = await sendMessage({ type, email: email.trim(), password });
      if (res.ok) {
        setPassword('');
        setFeedback({ text: 'Sync is on for this device.', kind: 'success' });
      } else {
        setFeedback({ text: res.error ?? 'Something went wrong.', kind: 'error' });
      }
    } catch (err) {
      // The service worker never replied (e.g. it crashed on startup).
      setFeedback({
        text: `Could not reach the sync worker: ${(err as Error).message}. Check the extension’s service-worker console.`,
        kind: 'error',
      });
    }
  };

  const signOut = async () => {
    await sendMessage({ type: 'SYNC_SIGN_OUT' });
    setFeedback(null);
  };

  if (!isFirebaseConfigured) {
    return (
      <section className="section">
        <h2>Cloud Sync</h2>
        <p className="hint">
          Sync isn’t configured yet. Add your Firebase web config in{' '}
          <code>src/shared/firebaseConfig.ts</code> to enable syncing tasks, streaks, flashcards,
          and more across the extension and the iPhone app.
        </p>
      </section>
    );
  }

  return (
    <section className="section">
      <h2>Cloud Sync</h2>
      <p className="hint">
        Sign in to sync your tasks, streaks, gamification, flashcards, papers, and bookmarks across
        this browser and the iPhone app. Use the same email + password on every device.
      </p>

      {signedIn ? (
        <>
          <div className="setting-row">
            <span>
              Signed in as <strong>{sync.email ?? 'your account'}</strong>
            </span>
            <button type="button" className="secondary-btn" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
          <p className="hint">
            {sync.lastSyncedAt > 0
              ? `Last synced: ${new Date(sync.lastSyncedAt).toLocaleString()}`
              : 'Waiting for first sync…'}
            {sync.lastError ? ` · Error: ${sync.lastError}` : ''}
          </p>
        </>
      ) : (
        <form
          className="add-feed-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run('SYNC_SIGN_IN', 'Signing in');
          }}
        >
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password (6+ characters)"
          />
          <button type="submit">Sign in</button>
          <button
            type="button"
            className="secondary-btn"
            onClick={() => void run('SYNC_SIGN_UP', 'Creating account')}
          >
            Create account
          </button>
        </form>
      )}

      {feedback && <p className={`feedback ${feedback.kind}`}>{feedback.text}</p>}
    </section>
  );
}
