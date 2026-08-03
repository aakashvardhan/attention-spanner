import { MAX_NOTES } from '../shared/constants';
import { qualifiesDailyBrainDump } from '../shared/dailyBrainDump';
import { localDate } from '../shared/format';
import { seal } from '../shared/notesVault';
import { getLocal, setLocal } from '../shared/storage';
import type { BrainDumpNote } from '../shared/types';
import { syncSessionAccessRules } from './accessRules';
import { recordEvent } from './gamification';
import { addTask } from './tasks';

/**
 * Brain-dump note writes, serialized in the service worker like tasks.
 * The raw dump is saved BEFORE structuring so a closed popup or crashed
 * inference never loses the user's thoughts.
 *
 * When the notes vault is on, every write seals its content with the vault's
 * public key — which is stored in the clear, so capture keeps working while
 * notes are locked. Nothing here ever decrypts: the three blobs are independent
 * (see shared/notesVault.ts) and plaintext always arrives in the message, so the
 * worker never needs the passcode.
 */

export async function saveNote(
  rawText: string,
): Promise<{ note: BrainDumpNote; dailyGateCompleted: boolean }> {
  const { notes, notesVault } = await getLocal('notes', 'notesVault');
  const id = crypto.randomUUID();
  const trimmed = rawText.trim();
  const now = Date.now();
  const note: BrainDumpNote = {
    id,
    rawText: notesVault ? '' : trimmed,
    ...(notesVault ? { encRaw: await seal(trimmed, notesVault, id) } : {}),
    status: 'raw',
    bullets: [],
    proposedTasks: [],
    createdAt: now,
    structuredAt: null,
    updatedAt: now,
  };
  notes.unshift(note);
  if (notes.length > MAX_NOTES) notes.length = MAX_NOTES;
  const dailyGateCompleted = qualifiesDailyBrainDump(trimmed);
  await setLocal({
    notes,
    ...(dailyGateCompleted
      ? {
          dailyBrainDumpGate: {
            date: localDate(new Date(now)),
            completedAt: now,
            noteId: id,
          },
        }
      : {}),
  });
  if (dailyGateCompleted) await syncSessionAccessRules();
  return { note, dailyGateCompleted };
}

/**
 * Rewrite a note's text — the "Connect" action, which wraps a title the note
 * already names in `[[…]]`.
 *
 * The caller supplies the whole rewritten text rather than the title to wrap,
 * because a sealed note's plaintext exists only in the page that decrypted it;
 * the worker holds ciphertext and could not perform the edit itself. Re-sealing
 * here keeps encryption where every other note write already does it.
 */
export async function applyStructureResult(
  id: string,
  bullets: string[],
  tasks: string[],
): Promise<void> {
  const { notes, notesVault } = await getLocal('notes', 'notesVault');
  const note = notes.find((n) => n.id === id);
  // Already-structured guard doubles as double-award protection
  if (!note || note.status === 'structured') return;
  note.status = 'structured';
  note.structuredAt = Date.now();
  if (notesVault) {
    note.bullets = [];
    note.encBullets = await seal(JSON.stringify(bullets), notesVault, id);
    note.proposedTasks = await Promise.all(
      tasks.map(async (text) => ({
        text: '',
        addedTaskId: null,
        encText: await seal(text, notesVault, id),
      })),
    );
  } else {
    note.bullets = bullets;
    note.proposedTasks = tasks.map((text) => ({ text, addedTaskId: null }));
  }
  await setLocal({ notes });
  await recordEvent('braindump_structured');
}

export async function markNoteFailed(id: string): Promise<void> {
  const { notes } = await getLocal('notes');
  const note = notes.find((n) => n.id === id);
  if (!note || note.status === 'structured') return;
  note.status = 'failed';
  await setLocal({ notes });
}

export async function deleteNote(id: string): Promise<void> {
  const { notes } = await getLocal('notes');
  await setLocal({ notes: notes.filter((n) => n.id !== id) });
}

/**
 * Review-first: this is the only path from a brain dump into the task list.
 * Adds the checked proposed tasks and links each back to its note entry.
 *
 * The caller passes the text alongside the index because an encrypted note's
 * `proposedTasks[i].text` is blank here — flipping `addedTaskId` needs no key,
 * but creating the Task does.
 */
export async function confirmNoteTasks(
  id: string,
  chosen: { index: number; text: string }[],
): Promise<{ addedCount: number }> {
  const { notes } = await getLocal('notes');
  const note = notes.find((n) => n.id === id);
  if (!note) return { addedCount: 0 };

  let addedCount = 0;
  for (const { index, text } of chosen) {
    const proposed = note.proposedTasks[index];
    if (!proposed || proposed.addedTaskId !== null) continue;
    const task = await addTask(text, 'braindump');
    proposed.addedTaskId = task.id;
    addedCount += 1;
  }
  await setLocal({ notes });
  return { addedCount };
}
