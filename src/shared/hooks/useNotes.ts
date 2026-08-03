import { useCallback, useEffect, useState } from 'react';
import { structureBrainDump } from '../ai/brainDump';
import { sendMessage } from '../messages';
import { open } from '../notesVault';
import type { BrainDumpNote } from '../types';
import { useStorageValue } from './useStorageValue';

/**
 * Notes state + mutations. Structuring runs in this page (Prompt API needs a
 * document + user activation); results persist through the service worker.
 *
 * When the vault is on, stored notes carry ciphertext and blank content fields;
 * `privateKey` (from useNotesLock) decrypts them back into the plain shape the
 * UI already renders. It is null while locked, and then sealed notes are simply
 * absent — there is nothing to show without the passcode.
 */
export function useNotes(privateKey: CryptoKey | null) {
  const [stored, loaded] = useStorageValue('notes');
  const [notes, setNotes] = useState<BrainDumpNote[]>([]);
  const [decrypted, setDecrypted] = useState(false);

  useEffect(() => {
    let alive = true;
    setDecrypted(false);
    void decryptNotes(stored, privateKey).then((next) => {
      if (!alive) return;
      setNotes(next);
      setDecrypted(true);
    });
    return () => {
      alive = false;
    };
  }, [stored, privateKey]);

  const deleteNote = useCallback((id: string) => sendMessage({ type: 'DELETE_NOTE', id }), []);

  /** Structure (or re-structure) an already-saved note, e.g. from history */
  const structureNote = useCallback(async (id: string, rawText: string) => {
    try {
      const result = await structureBrainDump(rawText);
      await sendMessage({
        type: 'STRUCTURE_NOTE_RESULT',
        id,
        bullets: result.bullets,
        tasks: result.tasks,
      });
    } catch (error) {
      await sendMessage({ type: 'NOTE_FAILED', id });
      throw error;
    }
  }, []);

  const confirmTasks = useCallback(
    (id: string, tasks: { index: number; text: string }[]) =>
      sendMessage({ type: 'CONFIRM_NOTE_TASKS', id, tasks }),
    [],
  );

  return { notes, loaded: loaded && decrypted, deleteNote, structureNote, confirmTasks };
}

/**
 * Fill the content fields of any sealed notes. A note that fails to open (a
 * blob from a vault that has since been replaced) is dropped rather than
 * rendered as an empty row.
 */
async function decryptNotes(
  stored: BrainDumpNote[],
  privateKey: CryptoKey | null,
): Promise<BrainDumpNote[]> {
  const out: BrainDumpNote[] = [];
  for (const note of stored) {
    if (note.encRaw === undefined) {
      out.push(note);
      continue;
    }
    if (!privateKey) continue;
    try {
      out.push({
        ...note,
        rawText: await open(note.encRaw, privateKey, note.id),
        bullets: note.encBullets
          ? (JSON.parse(await open(note.encBullets, privateKey, note.id)) as string[])
          : [],
        proposedTasks: await Promise.all(
          note.proposedTasks.map(async (t) => ({
            ...t,
            text: t.encText ? await open(t.encText, privateKey, note.id) : t.text,
          })),
        ),
      });
    } catch {
      // Undecryptable with this key — omit rather than show a blank note
    }
  }
  return out;
}
