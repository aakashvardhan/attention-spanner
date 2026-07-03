import { useCallback } from 'react';
import { sendMessage } from '../messages';
import type { Task } from '../types';
import { useStorageValue } from './useStorageValue';

/**
 * Task state + mutations. All writes go through the service worker so
 * concurrent surfaces (popup, capture window, newtab) never clobber each other.
 */
export function useTasks() {
  const [tasks, loaded] = useStorageValue('tasks');

  const openTasks = tasks.filter((t) => t.completedAt === null);
  const completedTasks = tasks.filter((t) => t.completedAt !== null);

  const addTask = useCallback(
    (text: string, source: Task['source']) => sendMessage({ type: 'ADD_TASK', text, source }),
    [],
  );
  const toggleTask = useCallback((id: string) => sendMessage({ type: 'TOGGLE_TASK', id }), []);
  const deleteTask = useCallback((id: string) => sendMessage({ type: 'DELETE_TASK', id }), []);
  const moveTask = useCallback(
    (id: string, toIndex: number) => sendMessage({ type: 'MOVE_TASK', id, toIndex }),
    [],
  );

  return { tasks, openTasks, completedTasks, loaded, addTask, toggleTask, deleteTask, moveTask };
}
