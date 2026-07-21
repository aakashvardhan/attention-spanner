import { sendMessage } from '../../messages';
import { resolveTaskOrThrow, type Connector } from './base';

export const tasksConnector: Connector = {
  id: 'tasks',
  label: 'Tasks',
  isAvailable: () => true,
  tools: [
    {
      name: 'add_task',
      description: 'Add a new to-do task to the task list.',
      params: {
        type: 'object',
        required: ['text'],
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: 'The task text, imperative, short', maxLength: 300 },
        },
      },
      confirm: true,
      palette: { label: 'Add task', keywords: ['todo', 'task', 'new'], argPlaceholder: 'task text' },
      summary: (p) => `Add task “${p.text as string}”`,
      run: async (p) => {
        const res = await sendMessage({ type: 'ADD_TASK', text: p.text as string, source: 'newtab' });
        return `Added task “${res.task.text}”.`;
      },
    },
    {
      name: 'complete_task',
      description: 'Mark an existing open task as done. Takes the task wording, not an id.',
      params: {
        type: 'object',
        required: ['task'],
        additionalProperties: false,
        properties: {
          task: { type: 'string', description: 'Words identifying the task to complete', maxLength: 300 },
        },
      },
      confirm: true,
      summary: (p) => `Mark “${p.task as string}” as done`,
      run: async (p) => {
        const task = await resolveTaskOrThrow(p.task as string);
        await sendMessage({ type: 'TOGGLE_TASK', id: task.id });
        return `Marked “${task.text}” as done.`;
      },
    },
    {
      name: 'snooze_task',
      description: 'Snooze reminders for an open task for some minutes (default 60).',
      params: {
        type: 'object',
        required: ['task'],
        additionalProperties: false,
        properties: {
          task: { type: 'string', description: 'Words identifying the task to snooze', maxLength: 300 },
          minutes: { type: 'number', description: 'Minutes to snooze for', minimum: 5, maximum: 1440 },
        },
      },
      confirm: true,
      summary: (p) => `Snooze “${p.task as string}” for ${(p.minutes as number) ?? 60} min`,
      run: async (p) => {
        const task = await resolveTaskOrThrow(p.task as string);
        const minutes = (p.minutes as number) ?? 60;
        await sendMessage({ type: 'SNOOZE_TASK', id: task.id, minutes });
        return `Snoozed “${task.text}” for ${minutes} minutes.`;
      },
    },
    {
      name: 'delete_task',
      description:
        'Delete/remove a task from the list entirely (not complete it — use complete_task for that). Takes the task wording, not an id.',
      params: {
        type: 'object',
        required: ['task'],
        additionalProperties: false,
        properties: {
          task: { type: 'string', description: 'Words identifying the task to delete', maxLength: 300 },
        },
      },
      confirm: true,
      summary: (p) => `Delete task “${p.task as string}”`,
      run: async (p) => {
        const task = await resolveTaskOrThrow(p.task as string);
        await sendMessage({ type: 'DELETE_TASK', id: task.id });
        return `Deleted “${task.text}”.`;
      },
    },
    {
      name: 'edit_task',
      description:
        'Rename/rewrite the text of an existing open task. Takes the current task wording and the new text.',
      params: {
        type: 'object',
        required: ['task', 'newText'],
        additionalProperties: false,
        properties: {
          task: { type: 'string', description: 'Words identifying the task to rename', maxLength: 300 },
          newText: { type: 'string', description: 'The new task text', maxLength: 300 },
        },
      },
      confirm: true,
      summary: (p) => `Rename “${p.task as string}” to “${p.newText as string}”`,
      run: async (p) => {
        const task = await resolveTaskOrThrow(p.task as string);
        await sendMessage({ type: 'EDIT_TASK', id: task.id, text: p.newText as string });
        return `Renamed “${task.text}” to “${(p.newText as string).trim()}”.`;
      },
    },
  ],
};
