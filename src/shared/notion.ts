import type { AnyProgress, BookmarkLink, BrainDumpNote, Task } from './types';

/**
 * Pure Notion payload builders and queue helpers — no chrome.*, no fetch,
 * so everything here is unit-testable. The service-worker client lives in
 * src/background/notion.ts.
 */

export const NOTION_API_BASE = 'https://api.notion.com';
// 2022-06-28 keeps `parent: { database_id }` semantics (newer versions parent on data sources)
export const NOTION_VERSION = '2022-06-28';

/** Conventional non-title property names the pushes expect in the target DBs */
export const LINKS_URL_PROP = 'URL';
export const LINKS_TAGS_PROP = 'Tags';
export const READING_URL_PROP = 'URL';
export const READING_TYPE_PROP = 'Type';
export const READING_DATE_PROP = 'Finished';

export const MAX_NOTION_QUEUE = 50;
export const MAX_PUSH_ATTEMPTS = 10;
/** Notion caps a single rich_text element at 2000 chars */
const RICH_TEXT_CHUNK = 2000;

export type NotionPushKind = 'link' | 'braindump' | 'task-create' | 'task-complete' | 'reading';

export interface NotionPush {
  id: string;
  kind: NotionPushKind;
  method: 'POST' | 'PATCH';
  /** e.g. '/v1/pages' or '/v1/pages/<pageId>' */
  path: string;
  body: unknown;
  /** Set for 'task-create' so the created page id can be written back to the Task */
  taskId?: string;
  createdAt: number;
  attempts: number;
}

export interface NotionStatus {
  lastSuccessAt: number;
  lastError: string;
  lastErrorAt: number;
  /** True after a 401 — pauses all pushes until a new token is saved */
  authError: boolean;
}

export interface NotionDbSummary {
  id: string;
  title: string;
  /** Actual property names detected by type ('' = the DB has no property of that type) */
  props: {
    urlProp: string;
    tagsProp: string;
    typeProp: string;
    dateProp: string;
    /** Best-guess checkbox property for task completion; '' = none */
    checkboxProp: string;
  };
}

function rt(text: string) {
  return [{ text: { content: text } }];
}

export function chunkRichText(text: string): { text: { content: string } }[] {
  const chunks = [];
  for (let i = 0; i < text.length; i += RICH_TEXT_CHUNK) {
    chunks.push({ text: { content: text.slice(i, i + RICH_TEXT_CHUNK) } });
  }
  return chunks.length > 0 ? chunks : [{ text: { content: '' } }];
}

export function buildLinkPage(
  bookmark: BookmarkLink,
  groupName: string | null,
  dbId: string,
  urlProp: string = LINKS_URL_PROP,
  tagsProp: string = LINKS_TAGS_PROP,
) {
  // Prop names come from type-based detection at DB-pick time; '' = DB lacks that type
  const properties: Record<string, unknown> = {
    title: { title: rt(bookmark.title || bookmark.url) },
    ...(urlProp ? { [urlProp]: { url: bookmark.url } } : {}),
    // Notion auto-creates unknown multi_select options, so group names map directly
    ...(groupName && tagsProp ? { [tagsProp]: { multi_select: [{ name: groupName }] } } : {}),
  };
  return { parent: { database_id: dbId }, properties };
}

export function noteTitle(note: BrainDumpNote): string {
  const firstLine = note.rawText.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  if (firstLine === '') return new Date(note.createdAt).toLocaleDateString();
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

export function buildBrainDumpPage(note: BrainDumpNote, dbId: string) {
  const children: unknown[] = [
    { paragraph: { rich_text: chunkRichText(note.rawText) } },
    ...note.bullets.map((b) => ({ bulleted_list_item: { rich_text: rt(b) } })),
    ...note.proposedTasks.map((t) => ({ to_do: { rich_text: rt(t.text), checked: false } })),
  ];
  return {
    parent: { database_id: dbId },
    properties: { title: { title: rt(noteTitle(note)) } },
    children,
  };
}

export function buildTaskPage(task: Task, dbId: string) {
  // Title-only so it works with any database ('title' is the reserved key)
  return {
    parent: { database_id: dbId },
    properties: { title: { title: rt(task.text) } },
  };
}

export function buildTaskCompletePatch(doneProp: string, completed: boolean) {
  return { properties: { [doneProp]: { checkbox: completed } } };
}

export function buildReadingLogPage(
  progress: AnyProgress,
  dbId: string,
  urlProp: string = READING_URL_PROP,
  typeProp: string = READING_TYPE_PROP,
  dateProp: string = READING_DATE_PROP,
) {
  const finishedAt = progress.completedAt ?? Date.now();
  const properties: Record<string, unknown> = {
    title: { title: rt(progress.title || progress.url) },
    ...(urlProp ? { [urlProp]: { url: progress.url } } : {}),
    ...(typeProp
      ? { [typeProp]: { select: { name: progress.kind === 'video' ? 'Video' : 'Article' } } }
      : {}),
    ...(dateProp
      ? { [dateProp]: { date: { start: new Date(finishedAt).toISOString().slice(0, 10) } } }
      : {}),
  };
  return { parent: { database_id: dbId }, properties };
}

/** Cap the queue, dropping oldest entries first. Returns a new array. */
export function enqueueInto(queue: NotionPush[], item: NotionPush): NotionPush[] {
  const next = [...queue, item];
  return next.length > MAX_NOTION_QUEUE ? next.slice(next.length - MAX_NOTION_QUEUE) : next;
}

/** null status = network error (fetch threw) */
export function classifyFailure(status: number | null): 'retryable' | 'fatal' | 'auth' {
  if (status === 401) return 'auth';
  if (status === 400 || status === 404) return 'fatal';
  return 'retryable';
}
