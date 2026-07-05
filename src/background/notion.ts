import {
  buildBrainDumpPage,
  buildLinkPage,
  buildReadingLogPage,
  buildTaskCompletePatch,
  buildTaskPage,
  classifyFailure,
  enqueueInto,
  MAX_PUSH_ATTEMPTS,
  NOTION_API_BASE,
  NOTION_VERSION,
  LINKS_TAGS_PROP,
  LINKS_URL_PROP,
  READING_DATE_PROP,
  READING_TYPE_PROP,
  type NotionDbSummary,
  type NotionPush,
  type NotionPushKind,
} from '../shared/notion';
import { getLocal, getSettings, setLocal } from '../shared/storage';
import type { AnyProgress, BookmarkLink, BrainDumpNote, Task } from '../shared/types';

/**
 * One-way push to Notion. Queue-first: every push lands in notionQueue,
 * then flushQueue() drains it immediately; the same loop serves offline
 * retries (10-min alarm) and SW-startup drains. Pushes must never fail the
 * primary action — all entry points swallow their own errors.
 */

const REQUEST_SPACING_MS = 350; // ~3 req/s Notion rate limit headroom

async function notionFetch(
  token: string,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${NOTION_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function recordError(message: string): Promise<void> {
  const { notionStatus } = await getLocal('notionStatus');
  await setLocal({
    notionStatus: { ...notionStatus, lastError: message, lastErrorAt: Date.now() },
  });
}

/** Serialize queue read-modify-writes within this SW lifetime */
let queueLock: Promise<void> = Promise.resolve();

function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueLock.then(fn);
  queueLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function newPush(
  kind: NotionPushKind,
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
  taskId?: string,
): NotionPush {
  return {
    id: crypto.randomUUID(),
    kind,
    method,
    path,
    body,
    ...(taskId !== undefined ? { taskId } : {}),
    createdAt: Date.now(),
    attempts: 0,
  };
}

async function enqueue(item: NotionPush): Promise<void> {
  await withQueueLock(async () => {
    const { notionQueue } = await getLocal('notionQueue');
    await setLocal({ notionQueue: enqueueInto(notionQueue, item) });
  });
  void flushQueue();
}

async function dequeue(id: string): Promise<void> {
  await withQueueLock(async () => {
    const { notionQueue } = await getLocal('notionQueue');
    await setLocal({ notionQueue: notionQueue.filter((p) => p.id !== id) });
  });
}

async function bumpOrDrop(item: NotionPush, error: string): Promise<void> {
  await withQueueLock(async () => {
    const { notionQueue } = await getLocal('notionQueue');
    const stored = notionQueue.find((p) => p.id === item.id);
    if (!stored) return;
    stored.attempts += 1;
    const next =
      stored.attempts >= MAX_PUSH_ATTEMPTS
        ? notionQueue.filter((p) => p.id !== item.id)
        : notionQueue;
    await setLocal({ notionQueue: next });
  });
  await recordError(error);
}

/** After a task-create push lands, write the page id back and reconcile completion */
async function reconcileTaskCreate(taskId: string, pageId: string): Promise<void> {
  const { tasks } = await getLocal('tasks');
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return; // deleted before the push landed — nothing to reconcile
  task.notionPageId = pageId;
  await setLocal({ tasks });
  // Completed (or re-opened) while the create was still queued: sync the checkbox now
  const settings = await getSettings();
  if (task.completedAt !== null && settings.notionTasksDoneProp !== '') {
    await enqueue(
      newPush(
        'task-complete',
        'PATCH',
        `/v1/pages/${pageId}`,
        buildTaskCompletePatch(settings.notionTasksDoneProp, true),
      ),
    );
  }
}

let flushing: Promise<void> | null = null;

export function flushQueue(): Promise<void> {
  flushing ??= doFlush().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function doFlush(): Promise<void> {
  for (;;) {
    const { notionQueue, notionStatus } = await getLocal('notionQueue', 'notionStatus');
    const settings = await getSettings();
    if (notionQueue.length === 0 || settings.notionToken === '' || notionStatus.authError) return;

    const item = notionQueue[0];
    let response: Response | null = null;
    try {
      response = await notionFetch(settings.notionToken, item.method, item.path, item.body);
    } catch {
      // network error — retryable
    }

    if (response?.ok) {
      await dequeue(item.id);
      const { notionStatus: status } = await getLocal('notionStatus');
      await setLocal({ notionStatus: { ...status, lastSuccessAt: Date.now(), lastError: '' } });
      if (item.kind === 'task-create' && item.taskId) {
        const { id } = (await response.json()) as { id: string };
        await reconcileTaskCreate(item.taskId, id);
      }
    } else {
      const status = response?.status ?? null;
      let message = `Notion request failed (${status ?? 'network error'})`;
      if (response) {
        try {
          const err = (await response.json()) as { message?: string };
          if (err.message) message = err.message;
        } catch {
          // keep the generic message
        }
      }
      const kind = classifyFailure(status);
      if (kind === 'auth') {
        const { notionStatus: s } = await getLocal('notionStatus');
        await setLocal({
          notionStatus: { ...s, authError: true, lastError: message, lastErrorAt: Date.now() },
        });
        return; // paused until a new token is saved
      }
      if (kind === 'fatal') {
        await dequeue(item.id);
        await recordError(message);
      } else {
        await bumpOrDrop(item, message);
        return; // stop this flush; the alarm retries later
      }
    }

    await new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS));
  }
}

// ---- Entry points called from feature modules (never throw) ----

export async function pushLink(bookmark: BookmarkLink): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notionPushLinks || settings.notionToken === '' || settings.notionLinksDbId === '')
      return;
    let groupName: string | null = null;
    if (bookmark.groupId !== null) {
      const { bookmarkGroups } = await getLocal('bookmarkGroups');
      groupName = bookmarkGroups.find((g) => g.id === bookmark.groupId)?.name ?? null;
    }
    await enqueue(
      newPush(
        'link',
        'POST',
        '/v1/pages',
        buildLinkPage(
          bookmark,
          groupName,
          settings.notionLinksDbId,
          settings.notionLinksUrlProp,
          settings.notionLinksTagsProp,
        ),
      ),
    );
  } catch (error) {
    console.error('[notion] pushLink failed:', error);
  }
}

/** Marks the note pushed at enqueue time so retry/structure paths can't double-push */
export async function pushBrainDump(note: BrainDumpNote): Promise<void> {
  try {
    const settings = await getSettings();
    if (
      !settings.notionPushBrainDumps ||
      settings.notionToken === '' ||
      settings.notionBrainDumpDbId === ''
    )
      return;
    const { notes } = await getLocal('notes');
    const stored = notes.find((n) => n.id === note.id);
    if (!stored || stored.notionPushedAt != null) return;
    stored.notionPushedAt = Date.now();
    await setLocal({ notes });
    await enqueue(
      newPush('braindump', 'POST', '/v1/pages', buildBrainDumpPage(stored, settings.notionBrainDumpDbId)),
    );
  } catch (error) {
    console.error('[notion] pushBrainDump failed:', error);
  }
}

export async function pushTaskCreate(task: Task): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notionPushTasks || settings.notionToken === '' || settings.notionTasksDbId === '')
      return;
    await enqueue(
      newPush('task-create', 'POST', '/v1/pages', buildTaskPage(task, settings.notionTasksDbId), task.id),
    );
  } catch (error) {
    console.error('[notion] pushTaskCreate failed:', error);
  }
}

export async function pushTaskToggle(task: Task): Promise<void> {
  try {
    const settings = await getSettings();
    if (
      !settings.notionPushTasks ||
      settings.notionToken === '' ||
      settings.notionTasksDoneProp === '' ||
      task.notionPageId === undefined
    )
      return;
    await enqueue(
      newPush(
        'task-complete',
        'PATCH',
        `/v1/pages/${task.notionPageId}`,
        buildTaskCompletePatch(settings.notionTasksDoneProp, task.completedAt !== null),
      ),
    );
  } catch (error) {
    console.error('[notion] pushTaskToggle failed:', error);
  }
}

export async function pushReadingFinished(progress: AnyProgress): Promise<void> {
  try {
    const settings = await getSettings();
    if (
      !settings.notionPushReading ||
      settings.notionToken === '' ||
      settings.notionReadingLogDbId === ''
    )
      return;
    await enqueue(
      newPush(
        'reading',
        'POST',
        '/v1/pages',
        buildReadingLogPage(
          progress,
          settings.notionReadingLogDbId,
          settings.notionReadingUrlProp,
          settings.notionReadingTypeProp,
          settings.notionReadingDateProp,
        ),
      ),
    );
  } catch (error) {
    console.error('[notion] pushReadingFinished failed:', error);
  }
}

/**
 * Safety net for notes saved with willStructure=true whose popup closed
 * mid-inference: after an hour with no terminal event, push them raw.
 */
export async function sweepUnpushedNotes(): Promise<void> {
  try {
    const settings = await getSettings();
    if (
      !settings.notionPushBrainDumps ||
      settings.notionToken === '' ||
      settings.notionBrainDumpDbId === ''
    )
      return;
    const { notes } = await getLocal('notes');
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const note of notes) {
      if (note.status === 'raw' && note.notionPushedAt == null && note.createdAt < cutoff) {
        await pushBrainDump(note);
      }
    }
  } catch (error) {
    console.error('[notion] sweepUnpushedNotes failed:', error);
  }
}

// ---- Options-page support ----

interface SearchResult {
  id: string;
  title?: { plain_text: string }[];
  properties?: Record<string, { type: string }>;
}

export async function listDatabases(): Promise<{
  ok: boolean;
  databases: NotionDbSummary[];
  error: string | null;
}> {
  const settings = await getSettings();
  if (settings.notionToken === '') return { ok: false, databases: [], error: 'No token saved' };

  const databases: NotionDbSummary[] = [];
  let cursor: string | undefined;
  try {
    do {
      const response = await notionFetch(settings.notionToken, 'POST', '/v1/search', {
        filter: { property: 'object', value: 'database' },
        page_size: 100,
        ...(cursor !== undefined ? { start_cursor: cursor } : {}),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { message?: string };
        return { ok: false, databases: [], error: err.message ?? `HTTP ${response.status}` };
      }
      const data = (await response.json()) as {
        results: SearchResult[];
        next_cursor: string | null;
      };
      for (const db of data.results) {
        const props = db.properties ?? {};
        const propNames = Object.keys(props);
        // Detect by TYPE, preferring the conventional name — robust to renames,
        // casing, and invisible characters in property names
        const byType = (type: string, preferredName: string): string => {
          const candidates = propNames.filter((n) => props[n].type === type);
          const preferred = candidates.find(
            (n) => n.trim().toLowerCase() === preferredName.toLowerCase(),
          );
          return preferred ?? candidates[0] ?? '';
        };
        const checkboxes = propNames.filter((n) => props[n].type === 'checkbox');
        const preferredCheckbox = checkboxes.find((n) =>
          /^(done|complete|completed|checked)$/i.test(n.trim()),
        );
        databases.push({
          id: db.id,
          title: db.title?.map((t) => t.plain_text).join('') || 'Untitled',
          props: {
            urlProp: byType('url', LINKS_URL_PROP),
            tagsProp: byType('multi_select', LINKS_TAGS_PROP),
            typeProp: byType('select', READING_TYPE_PROP),
            dateProp: byType('date', READING_DATE_PROP),
            checkboxProp: preferredCheckbox ?? checkboxes[0] ?? '',
          },
        });
      }
      cursor = data.next_cursor ?? undefined;
    } while (cursor !== undefined);
  } catch {
    return { ok: false, databases: [], error: 'Network error reaching api.notion.com' };
  }
  return { ok: true, databases, error: null };
}

export async function testConnection(): Promise<{
  ok: boolean;
  name: string | null;
  error: string | null;
}> {
  const settings = await getSettings();
  if (settings.notionToken === '') return { ok: false, name: null, error: 'No token saved' };
  try {
    const response = await notionFetch(settings.notionToken, 'GET', '/v1/users/me');
    if (!response.ok) {
      const err = (await response.json().catch(() => ({}))) as { message?: string };
      if (response.status === 401) {
        const { notionStatus } = await getLocal('notionStatus');
        await setLocal({
          notionStatus: {
            ...notionStatus,
            authError: true,
            lastError: err.message ?? 'Invalid token',
            lastErrorAt: Date.now(),
          },
        });
      }
      return { ok: false, name: null, error: err.message ?? `HTTP ${response.status}` };
    }
    const user = (await response.json()) as { name?: string; bot?: { workspace_name?: string } };
    const { notionStatus } = await getLocal('notionStatus');
    await setLocal({ notionStatus: { ...notionStatus, authError: false, lastError: '' } });
    void flushQueue();
    return { ok: true, name: user.bot?.workspace_name ?? user.name ?? 'Notion', error: null };
  } catch {
    return { ok: false, name: null, error: 'Network error reaching api.notion.com' };
  }
}

/** Token changed in settings: clear the auth pause and drain whatever queued */
export async function handleTokenChanged(): Promise<void> {
  const { notionStatus } = await getLocal('notionStatus');
  await setLocal({ notionStatus: { ...notionStatus, authError: false, lastError: '' } });
  void flushQueue();
}
