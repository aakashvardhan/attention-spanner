import { useState } from 'react';
import { Button } from '../../shared/components/ui';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { MIN_PASSCODE_LENGTH } from '../../shared/notesLock';
import {
  createVault,
  exportPrivateKey,
  open,
  rewrapVault,
  seal,
  unlockVault,
  type NotesVault,
} from '../../shared/notesVault';
import { getLocal, setLocal, setSession } from '../../shared/storage';
import type { BrainDumpNote } from '../../shared/types';

type Feedback = { text: string; kind: 'success' | 'error' } | null;

const FORGET_PHRASE = 'delete my notes';

/** What one note became: a replacement, or `null` to drop it. */
type NoteRewrite = (note: BrainDumpNote) => Promise<BrainDumpNote | null> | null;

/** How many times to re-read before giving up on catching concurrent writes. */
const REWRITE_PASSES = 3;

/**
 * Rewrite every note `rewrite` claims, merging against a fresh read instead of
 * overwriting the array wholesale.
 *
 * The crypto below is a key operation per note, so this runs for a noticeable
 * while — long enough for the worker to save a brain dump underneath it (the
 * popup writes through SAVE_NOTE, which knows nothing about this page). Writing
 * back the snapshot we started from would drop that note silently. Instead each
 * pass re-reads and only handles what it hasn't already, and the final write
 * keeps anything that appeared too late to transform.
 *
 * Three answers from `rewrite`, and the difference matters: a bare null means
 * it does not claim this note (already in the target state — left exactly as
 * it is), a promise of a note means replace, and a promise of null means drop.
 */
async function rewriteNotes(rewrite: NoteRewrite): Promise<void> {
  const replace = new Map<string, BrainDumpNote>();
  const drop = new Set<string>();
  const handled = (note: BrainDumpNote) => replace.has(note.id) || drop.has(note.id);

  for (let pass = 0; pass < REWRITE_PASSES; pass++) {
    const { notes } = await getLocal('notes');
    let claimed = 0;
    for (const note of notes) {
      if (handled(note)) continue;
      // Exactly once per note per pass — the call itself starts the crypto.
      const result = rewrite(note);
      if (result === null) continue;
      claimed++;
      const next = await result;
      if (next) replace.set(note.id, next);
      else drop.add(note.id);
    }
    if (claimed === 0) break; // nothing appeared underneath us
  }

  const { notes: live } = await getLocal('notes');
  await setLocal({
    notes: live.filter((n) => !drop.has(n.id)).map((n) => replace.get(n.id) ?? n),
  });
}

/**
 * Seal every plain-text note in place. Needs only the vault's public key, so
 * this is the same operation the service worker performs on each new dump.
 */
async function sealExistingNotes(vault: NotesVault): Promise<void> {
  await rewriteNotes((note) => {
    // Already sealed — including anything the worker sealed just now
    if (note.encRaw !== undefined) return null;
    return (async () => ({
      ...note,
      rawText: '',
      encRaw: await seal(note.rawText, vault, note.id),
      bullets: [],
      encBullets: await seal(JSON.stringify(note.bullets), vault, note.id),
      proposedTasks: await Promise.all(
        note.proposedTasks.map(async (t) => ({
          ...t,
          text: '',
          encText: await seal(t.text, vault, note.id),
        })),
      ),
    }))();
  });
}

/** Decrypt every note back to plain text. A note this key cannot open is dropped. */
async function unsealAllNotes(privateKey: CryptoKey): Promise<void> {
  await rewriteNotes((note) => {
    // Narrowed out here rather than inside the closure below, where `note`
    // being captured widens encRaw back to string | undefined.
    const encRaw = note.encRaw;
    if (encRaw === undefined) return null; // already plain text
    return (async () => {
      try {
        const { encRaw: _sealed, encBullets, ...rest } = note;
        return {
          ...rest,
          rawText: await open(encRaw, privateKey, note.id),
          bullets: encBullets
            ? (JSON.parse(await open(encBullets, privateKey, note.id)) as string[])
            : [],
          proposedTasks: await Promise.all(
            note.proposedTasks.map(async ({ encText, ...t }) => ({
              ...t,
              text: encText ? await open(encText, privateKey, note.id) : t.text,
            })),
          ),
        };
      } catch {
        // Sealed by a vault this key does not match — leave it out
        return null;
      }
    })();
  });
}

export function PrivacySection() {
  const [vault, vaultLoaded] = useStorageValue('notesVault');
  const encrypted = vault !== null;

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [forget, setForget] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const clear = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setForget('');
  };

  const save = async () => {
    if (next.length < MIN_PASSCODE_LENGTH) {
      setFeedback({ text: `Use at least ${MIN_PASSCODE_LENGTH} characters.`, kind: 'error' });
      return;
    }
    if (next !== confirm) {
      setFeedback({ text: 'The two new passcodes do not match.', kind: 'error' });
      return;
    }
    setBusy(true);
    try {
      if (vault) {
        // Changing the passcode rewraps the key; the notes are never touched
        await setLocal({ notesVault: await rewrapVault(vault, current, next) });
        await setSession({ notesPrivateKey: '' });
        setFeedback({ text: 'Passcode changed. Notes are locked again.', kind: 'success' });
      } else {
        const created = await createVault(next);
        // Vault first, then seal. The other order leaves a window where the
        // worker saves a dump with no vault in storage yet, so it lands in
        // plain text after the user asked for encryption. Sealing is
        // idempotent and skips what the worker already sealed.
        await setLocal({ notesVault: created.vault });
        await sealExistingNotes(created.vault);
        // Stay unlocked — the user just proved the passcode by choosing it
        await setSession({ notesPrivateKey: await exportPrivateKey(created.privateKey) });
        setFeedback({
          text: 'Notes are encrypted. Keep the passcode somewhere safe.',
          kind: 'success',
        });
      }
      clear();
    } catch {
      setFeedback({ text: 'Current passcode is wrong.', kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!vault) return;
    setBusy(true);
    try {
      const key = await unlockVault(vault, current);
      // Vault last here, the opposite of save(): dropping it first would strand
      // any note still sealed if the loop below failed partway — the wrapped
      // key would already be gone. A dump the worker seals mid-loop is caught
      // by the next pass inside unsealAllNotes.
      await unsealAllNotes(key);
      await setLocal({ notesVault: null });
      await setSession({ notesPrivateKey: '' });
      clear();
      setFeedback({ text: 'Encryption off — notes are plain text again.', kind: 'success' });
    } catch {
      setFeedback({ text: 'Current passcode is wrong.', kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  /** Last resort: without the passcode the notes are genuinely unrecoverable. */
  const forgetEverything = async () => {
    setBusy(true);
    try {
      const { notes } = await getLocal('notes');
      await setLocal({
        notes: notes.filter((n) => n.encRaw === undefined),
        notesVault: null,
      });
      await setSession({ notesPrivateKey: '' });
      clear();
      setFeedback({ text: 'Encrypted notes deleted. Encryption is off.', kind: 'success' });
    } finally {
      setBusy(false);
    }
  };

  const unlockNow = async () => {
    if (!vault) return;
    setBusy(true);
    try {
      const key = await unlockVault(vault, current);
      await setSession({ notesPrivateKey: await exportPrivateKey(key) });
      setCurrent('');
      setFeedback({ text: 'Unlocked for this browser session.', kind: 'success' });
    } catch {
      setFeedback({ text: 'Current passcode is wrong.', kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  if (!vaultLoaded) return null;

  return (
    <section className="section">
      <h2>Private Notes</h2>
      <p className="hint">
        Encrypt brain dumps with a passcode. Each note is sealed with AES-256-GCM before it is
        written, so what sits on this disk — and in cloud sync, if it is on — is ciphertext, not
        your words. Reading history needs the passcode; unlocking lasts until you close the
        browser, or until you press Lock.
      </p>
      <p className="hint">
        Writing stays open. A new dump can always be saved while locked, because sealing needs only
        the public half of the key. Jarvis cannot search your notes while they are locked.
      </p>
      <p className="hint">
        The passcode is never stored, never synced, and cannot be recovered — lose it and the notes
        are gone for good. The key stays on this device, so other devices sync the notes but cannot
        open them. While a session is unlocked, the key is in memory and devtools can still reach
        past it.
      </p>

      <form
        className="add-feed-form"
        style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {encrypted && (
          <input
            type="password"
            value={current}
            autoComplete="off"
            placeholder="Current passcode"
            onChange={(e) => {
              setCurrent(e.target.value);
              setFeedback(null);
            }}
          />
        )}
        <input
          type="password"
          value={next}
          autoComplete="new-password"
          placeholder={encrypted ? 'New passcode' : `Passcode (${MIN_PASSCODE_LENGTH}+ characters)`}
          onChange={(e) => {
            setNext(e.target.value);
            setFeedback(null);
          }}
        />
        <input
          type="password"
          value={confirm}
          autoComplete="new-password"
          placeholder={encrypted ? 'Confirm new passcode' : 'Confirm passcode'}
          onChange={(e) => {
            setConfirm(e.target.value);
            setFeedback(null);
          }}
        />
        <div className="button-group">
          <button type="submit" disabled={busy || !next || !confirm}>
            {encrypted ? 'Change passcode' : 'Encrypt notes'}
          </button>
          {encrypted && (
            <>
              <button
                type="button"
                className="secondary-btn"
                disabled={busy || !current}
                onClick={() => void unlockNow()}
              >
                Unlock
              </button>
              <button
                type="button"
                className="secondary-btn"
                disabled={busy || !current}
                onClick={() => void remove()}
              >
                Turn off encryption
              </button>
            </>
          )}
        </div>
      </form>

      {feedback && <p className={`feedback ${feedback.kind}`}>{feedback.text}</p>}

      {encrypted && (
        <>
          <p className="hint" style={{ marginTop: 16 }}>
            Forgot the passcode? There is no way back into these notes. The only exit is to delete
            them — type <code>{FORGET_PHRASE}</code> to confirm.
          </p>
          <div className="button-group">
            <input
              value={forget}
              autoComplete="off"
              placeholder={FORGET_PHRASE}
              onChange={(e) => setForget(e.target.value)}
            />
            <Button
              variant="danger"
              disabled={busy || forget.trim() !== FORGET_PHRASE}
              onClick={() => void forgetEverything()}
            >
              Delete encrypted notes
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
