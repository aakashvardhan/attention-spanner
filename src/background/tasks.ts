import { rollChest } from '../shared/chests';
import { COMPLETED_TASK_TTL_MS, NOTIFICATION_IDS } from '../shared/constants';
import { localDate } from '../shared/format';
import { getLocal, getSettings, setLocal } from '../shared/storage';
import type { Task } from '../shared/types';
import { adjustXp, awardChest, awardXp, revokeXp } from './gamification';
import { pushTaskCreate, pushTaskToggle } from './notion';
import { recordTaskToggled } from './streaks';

/**
 * All task writes happen here in the service worker so the popup, the
 * capture window, and notification handlers never race each other.
 */

export async function addTask(text: string, source: Task['source']): Promise<Task> {
  const task: Task = {
    id: crypto.randomUUID(),
    text: text.trim(),
    createdAt: Date.now(),
    completedAt: null,
    snoozedUntil: null,
    source,
  };
  const { tasks } = await getLocal('tasks');
  tasks.unshift(task);
  await setLocal({ tasks });
  void pushTaskCreate(task);
  return task;
}

export async function toggleTask(id: string): Promise<void> {
  const { tasks } = await getLocal('tasks');
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  const completing = task.completedAt === null;
  const prevCompletedAt = task.completedAt;
  task.completedAt = completing ? Date.now() : null;
  // Chest odds are rolled once per task, ever — a persisted miss (bonusXp 0)
  // means un-complete/re-complete can't fish for a drop
  const firstRoll = completing && task.chest === undefined;
  if (firstRoll) {
    task.chest = { bonusXp: rollChest() ?? 0 };
  }
  await setLocal({ tasks });
  // Symmetric award/revoke so toggle-farming yields no XP
  const chestBonus = task.chest?.bonusXp ?? 0;
  if (completing) {
    await awardXp('task_completed');
    await recordTaskToggled(1);
    if (chestBonus > 0) {
      // First completion celebrates the drop; re-completions silently restore it
      if (firstRoll) await awardChest(chestBonus);
      else await adjustXp(chestBonus);
    }
  } else {
    await revokeXp('task_completed');
    if (chestBonus > 0) await adjustXp(-chestBonus);
    // Only walk back today's activity count — un-completing a task finished
    // on a past day must not corrupt that day's calendar cell
    if (prevCompletedAt !== null && localDate(new Date(prevCompletedAt)) === localDate()) {
      await recordTaskToggled(-1);
    }
  }
  void pushTaskToggle(task);
}

/**
 * Move an open task to `toIndex` within the open-task list. Completed tasks
 * keep their slots in the stored array so the Done section is unaffected.
 */
export async function moveTask(id: string, toIndex: number): Promise<void> {
  const { tasks } = await getLocal('tasks');
  const open = tasks.filter((t) => t.completedAt === null);
  const from = open.findIndex((t) => t.id === id);
  if (from < 0) return;
  const to = Math.max(0, Math.min(toIndex, open.length - 1));
  if (from === to) return;
  const [moved] = open.splice(from, 1);
  open.splice(to, 0, moved);
  let i = 0;
  await setLocal({ tasks: tasks.map((t) => (t.completedAt === null ? open[i++] : t)) });
}

/**
 * Rename an open task. No Notion push — only create/toggle push today, and a
 * rename shouldn't spawn a duplicate page.
 */
export async function editTask(id: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const { tasks } = await getLocal('tasks');
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.text = trimmed;
  task.updatedAt = Date.now();
  await setLocal({ tasks });
}

export async function deleteTask(id: string): Promise<void> {
  const { tasks } = await getLocal('tasks');
  await setLocal({ tasks: tasks.filter((t) => t.id !== id) });
}

export async function pruneCompletedTasks(): Promise<void> {
  const { tasks } = await getLocal('tasks');
  const cutoff = Date.now() - COMPLETED_TASK_TTL_MS;
  const kept = tasks.filter((t) => t.completedAt === null || t.completedAt > cutoff);
  if (kept.length !== tasks.length) {
    await setLocal({ tasks: kept });
  }
}

export async function snoozeTask(id: string, minutes: number): Promise<void> {
  const { tasks } = await getLocal('tasks');
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.snoozedUntil = Date.now() + minutes * 60 * 1000;
  await setLocal({ tasks });
}

export async function snoozeOpenTasks(durationMs: number): Promise<void> {
  const { tasks } = await getLocal('tasks');
  const until = Date.now() + durationMs;
  for (const task of tasks) {
    if (task.completedAt === null) {
      task.snoozedUntil = until;
    }
  }
  await setLocal({ tasks });
}

/**
 * One digest notification for all open, non-snoozed tasks. Fixed
 * notification ID so repeats replace rather than stack.
 */
export async function showTaskDigest(): Promise<void> {
  const settings = await getSettings();
  if (!settings.notificationsEnabled || settings.taskReminderIntervalMinutes <= 0) return;

  const { tasks } = await getLocal('tasks');
  const now = Date.now();
  const due = tasks.filter(
    (t) => t.completedAt === null && (t.snoozedUntil === null || t.snoozedUntil <= now),
  );
  if (due.length === 0) return;

  const oldest = due.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
  const message =
    due.length === 1
      ? `"${oldest.text}"`
      : `${due.length} open tasks · oldest: "${oldest.text}"`;

  chrome.notifications.create(NOTIFICATION_IDS.taskDigest, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: due.length === 1 ? 'Open task' : `${due.length} open tasks`,
    message,
    buttons: [{ title: 'Snooze 1h' }, { title: 'View tasks' }],
    priority: 0,
  });
}
