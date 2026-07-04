import { MAX_NOTES } from '../shared/constants';
import { getLocal, setLocal } from '../shared/storage';
import type { BrainDumpNote } from '../shared/types';
import { awardXp } from './gamification';
import { pushBrainDump } from './notion';
import { addTask } from './tasks';

/**
 * Brain-dump note writes, serialized in the service worker like tasks.
 * The raw dump is saved BEFORE structuring so a closed popup or crashed
 * inference never loses the user's thoughts.
 */

export async function saveNote(rawText: string, willStructure: boolean): Promise<BrainDumpNote> {
  const note: BrainDumpNote = {
    id: crypto.randomUUID(),
    rawText: rawText.trim(),
    status: 'raw',
    bullets: [],
    proposedTasks: [],
    createdAt: Date.now(),
    structuredAt: null,
    notionPushedAt: null,
  };
  const { notes } = await getLocal('notes');
  notes.unshift(note);
  if (notes.length > MAX_NOTES) notes.length = MAX_NOTES;
  await setLocal({ notes });
  // Raw-only saves are terminal; structure paths push at their own terminal event
  if (!willStructure) void pushBrainDump(note);
  return note;
}

export async function applyStructureResult(
  id: string,
  bullets: string[],
  tasks: string[],
): Promise<void> {
  const { notes } = await getLocal('notes');
  const note = notes.find((n) => n.id === id);
  // Already-structured guard doubles as double-award protection
  if (!note || note.status === 'structured') return;
  note.status = 'structured';
  note.bullets = bullets;
  note.proposedTasks = tasks.map((text) => ({ text, addedTaskId: null }));
  note.structuredAt = Date.now();
  await setLocal({ notes });
  await awardXp('braindump_structured');
  if (note.notionPushedAt == null) void pushBrainDump(note);
}

export async function markNoteFailed(id: string): Promise<void> {
  const { notes } = await getLocal('notes');
  const note = notes.find((n) => n.id === id);
  if (!note || note.status === 'structured') return;
  note.status = 'failed';
  await setLocal({ notes });
  if (note.notionPushedAt == null) void pushBrainDump(note);
}

export async function deleteNote(id: string): Promise<void> {
  const { notes } = await getLocal('notes');
  await setLocal({ notes: notes.filter((n) => n.id !== id) });
}

/**
 * Review-first: this is the only path from a brain dump into the task list.
 * Adds the checked proposed tasks and links each back to its note entry.
 */
export async function confirmNoteTasks(
  id: string,
  taskIndexes: number[],
): Promise<{ addedCount: number }> {
  const { notes } = await getLocal('notes');
  const note = notes.find((n) => n.id === id);
  if (!note) return { addedCount: 0 };

  let addedCount = 0;
  for (const index of taskIndexes) {
    const proposed = note.proposedTasks[index];
    if (!proposed || proposed.addedTaskId !== null) continue;
    const task = await addTask(proposed.text, 'braindump');
    proposed.addedTaskId = task.id;
    addedCount += 1;
  }
  await setLocal({ notes });
  return { addedCount };
}
