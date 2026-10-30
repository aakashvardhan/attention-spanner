import { useState, type FormEvent } from 'react';
import { formatRelativeDate } from '../../shared/format';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { getLocal, setLocal, withDumpLock } from '../../shared/storage';
import type { DumpEntry } from '../../shared/types';
import { VaultLockedError, openAll, unlockVault } from '../../shared/vault';

type Opened = DumpEntry & { id: string };

/**
 * The only place past dumps can be read. Locked until the passphrase or the
 * recovery code; the private key lives in this page's memory alone, so
 * closing or reloading the page locks it again.
 */
export function Dumps() {
  const [vault, loaded] = useStorageValue('vault');
  const [entries, setEntries] = useState<Opened[] | null>(null);
  /** Entries that would not open; counted so a damaged one never hides the rest */
  const [failed, setFailed] = useState(0);

  if (!loaded) return null;
  if (!vault) {
    return (
      <main className="dumps dumps-locked">
        <h1 className="dumps-title">Your dumps</h1>
        <p className="dumps-quiet">Nothing locked yet.</p>
      </main>
    );
  }
  if (!entries)
    return (
      <Unlock
        onOpen={(opened, broken) => {
          setEntries(opened);
          setFailed(broken);
        }}
      />
    );

  return (
    <main className="dumps">
      <header className="dumps-head">
        <h1 className="dumps-title">Your dumps</h1>
        <span className="dumps-quiet">Locks when you close this page</span>
      </header>
      {failed > 0 && (
        <p className="dumps-quiet" role="status">
          {failed === 1 ? "One entry couldn't be opened." : `${failed} entries couldn't be opened.`}
        </p>
      )}
      {entries.map((entry) => (
        <Entry key={entry.id} entry={entry} onDeleted={() => setEntries(entries.filter((e) => e.id !== entry.id))} />
      ))}
    </main>
  );
}

function Unlock({ onOpen }: { onOpen: (entries: Opened[], failed: number) => void }) {
  const [via, setVia] = useState<'passphrase' | 'recovery'>('passphrase');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!secret || busy) return;
    setBusy(true);
    setError('');
    try {
      const { vault, lockedDumps } = await getLocal('vault', 'lockedDumps');
      const key = await unlockVault(vault!, secret, via);
      const { opened, failed } = await openAll(key, lockedDumps);
      onOpen(opened, failed);
    } catch (err) {
      setError(err instanceof VaultLockedError ? err.message : "Couldn't open your dumps.");
      setBusy(false);
    }
  }

  return (
    <main className="dumps dumps-locked">
      <svg className="dumps-lock" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 11V8a4 4 0 0 1 8 0v3M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z" />
      </svg>
      <h1 className="dumps-title">Your dumps</h1>
      <p className="dumps-quiet">You chose to come here. Take your time.</p>
      <form onSubmit={(e) => void submit(e)}>
        <input
          className="dumps-secret"
          type={via === 'passphrase' ? 'password' : 'text'}
          aria-label={via === 'passphrase' ? 'Passphrase' : 'Recovery code'}
          placeholder={via === 'passphrase' ? 'Passphrase' : 'Recovery code'}
          autoFocus
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </form>
      {error && (
        <p className="dumps-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="dumps-link"
        onClick={() => {
          setVia(via === 'passphrase' ? 'recovery' : 'passphrase');
          setSecret('');
          setError('');
        }}
      >
        {via === 'passphrase' ? 'Use recovery code instead' : 'Use passphrase instead'}
      </button>
    </main>
  );
}

function Entry({ entry, onDeleted }: { entry: Opened; onDeleted: () => void }) {
  const [showRaw, setShowRaw] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function remove() {
    await withDumpLock(async () => {
      const { lockedDumps } = await getLocal('lockedDumps');
      await setLocal({ lockedDumps: lockedDumps.filter((d) => d.id !== entry.id) });
    });
    onDeleted();
  }

  return (
    <article className="dumps-entry">
      <div className="dumps-entry-head">
        <span>{formatRelativeDate(new Date(entry.createdAt))}</span>
        {confirming ? (
          <span className="dumps-confirm">
            Delete for good?
            <button type="button" className="dumps-link is-danger" onClick={() => void remove()}>
              Delete
            </button>
            <button type="button" className="dumps-link" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button type="button" className="dumps-link is-quiet" onClick={() => setConfirming(true)}>
            Delete
          </button>
        )}
      </div>
      {entry.bullets.length ? (
        <ul className="dumps-bullets">
          {entry.bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      ) : (
        <p className="dumps-quiet">No bullets for this one.</p>
      )}
      <button type="button" className="dumps-link" aria-expanded={showRaw} onClick={() => setShowRaw(!showRaw)}>
        {showRaw ? 'Hide what I wrote' : 'Show what I wrote'}
      </button>
      {showRaw && <p className="dumps-raw">{entry.text}</p>}
    </article>
  );
}
