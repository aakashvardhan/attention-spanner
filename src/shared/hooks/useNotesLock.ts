import { useCallback, useEffect, useState } from 'react';
import { notesLocked } from '../notesLock';
import { exportPrivateKey, importPrivateKey, unlockVault } from '../notesVault';
import { setSession } from '../storage';
import { useSessionValue } from './useSessionValue';
import { useStorageValue } from './useStorageValue';

/**
 * Vault state for the brain-dump history. The unwrapped key lives in session
 * storage, so every window unlocks at once and closing the browser re-locks.
 * Read paths take `privateKey` to decrypt; while locked it is null and there is
 * nothing to show, because storage holds only ciphertext.
 */
export function useNotesLock() {
  const [vault, vaultLoaded] = useStorageValue('notesVault');
  const [keyHex, keyLoaded] = useSessionValue('notesPrivateKey');
  const [privateKey, setPrivateKey] = useState<CryptoKey | null>(null);

  // Session storage can only carry the key as hex; revive it for this context.
  useEffect(() => {
    if (!keyHex) {
      setPrivateKey(null);
      return;
    }
    let alive = true;
    void importPrivateKey(keyHex).then((key) => {
      if (alive) setPrivateKey(key);
    });
    return () => {
      alive = false;
    };
  }, [keyHex]);

  const unlock = useCallback(
    async (passcode: string) => {
      if (!vault) return false;
      try {
        const key = await unlockVault(vault, passcode);
        await setSession({ notesPrivateKey: await exportPrivateKey(key) });
        return true;
      } catch {
        return false;
      }
    },
    [vault],
  );

  const lock = useCallback(() => setSession({ notesPrivateKey: '' }), []);

  const unlocked = keyHex !== '';
  return {
    // The key is imported asynchronously, so a decrypting caller must wait for it
    loaded: vaultLoaded && keyLoaded && (!unlocked || privateKey !== null),
    /** Encryption is on, so the Lock control is worth showing */
    enabled: vault !== null,
    locked: notesLocked(vault !== null, unlocked),
    privateKey,
    unlock,
    lock,
  };
}
