import { useCallback } from 'react';
import { structureBrainDump } from '../ai/brainDump';
import { sendMessage } from '../messages';
import { useStorageValue } from './useStorageValue';

/**
 * Notes state + mutations. Structuring runs in this page (Prompt API needs a
 * document + user activation); results persist through the service worker.
 */
export function useNotes() {
  const [notes, loaded] = useStorageValue('notes');

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
    (id: string, taskIndexes: number[]) =>
      sendMessage({ type: 'CONFIRM_NOTE_TASKS', id, taskIndexes }),
    [],
  );

  return { notes, loaded, deleteNote, structureNote, confirmTasks };
}
