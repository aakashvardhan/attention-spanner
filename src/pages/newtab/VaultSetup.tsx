import { useEffect, useRef, useState, type FormEvent } from 'react';
import { getLocal, setLocal, withDumpLock } from '../../shared/storage';
import type { DumpEntry, Vault } from '../../shared/types';
import { createVault, planSetup } from '../../shared/vault';

/**
 * First-time setup, offered right after the first bullets so the dump itself
 * never waits on it. Nothing is stored until "I wrote it down": closing the
 * tab before then leaves the dumps parked in the clear, and setup comes back
 * after the next Cmd+Enter. If another tab finishes setup first, its vault
 * stands and this one quietly seals into it (`onDone(true)`).
 */
export function VaultSetup({
  current,
  existing,
  onDone,
}: {
  current: DumpEntry & { id: string };
  /** The live stored vault; non-null means another tab got there first */
  existing: Vault | null;
  onDone: (usedExisting: boolean) => void;
}) {
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [made, setMade] = useState<{ vault: Vault; recoveryCode: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const committed = useRef(false);

  /** Seal everything waiting; locked copies are written before the clear ones go */
  async function commit(fresh: Vault) {
    if (committed.current) return;
    committed.current = true;
    const plan = await withDumpLock(async () => {
      const plan = await planSetup(await getLocal('vault', 'dumps', 'lockedDumps'), fresh, current);
      await setLocal({ vault: plan.vault, lockedDumps: plan.lockedDumps });
      await setLocal({ dumps: plan.dumps });
      return plan;
    });
    onDone(plan.vault !== fresh);
  }

  useEffect(() => {
    if (existing && !made) void commit(existing);
  }, [existing]); // eslint-disable-line react-hooks/exhaustive-deps

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!pass || pass !== confirm || busy) return;
    setBusy(true);
    setMade(await createVault(pass));
    setBusy(false);
  }

  async function finish() {
    if (!made || busy) return;
    setBusy(true);
    await commit(made.vault);
  }

  if (made) {
    return (
      <div className="notebook-setup">
        <p>Write this down. It's the only way back in if you forget your passphrase.</p>
        <p className="notebook-code">{made.recoveryCode}</p>
        <button type="button" className="edition-pill" disabled={busy} onClick={() => void finish()}>
          I wrote it down
        </button>
      </div>
    );
  }

  return (
    <form className="notebook-setup" onSubmit={(e) => void create(e)}>
      <p>Set a passphrase so this can lock.</p>
      <input
        type="password"
        aria-label="Passphrase"
        placeholder="Passphrase"
        autoComplete="new-password"
        autoFocus
        value={pass}
        onChange={(e) => setPass(e.target.value)}
      />
      <input
        type="password"
        aria-label="Passphrase again"
        placeholder="Passphrase again"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      <button type="submit" className="edition-pill" disabled={!pass || pass !== confirm || busy}>
        Lock it
      </button>
    </form>
  );
}
