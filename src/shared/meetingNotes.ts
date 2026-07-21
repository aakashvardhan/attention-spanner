/**
 * Notion meeting notes — pure types and mappers (query-row parsing, block
 * simplification, incremental-sync planning). All IO lives in
 * src/background/meetingNotes.ts, mirroring the notion.ts/calendar.ts split.
 */

/** Flattened block — nesting is a depth field, not children */
export type NoteBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string; depth: number }
  | { type: 'bullet'; text: string; depth: number }
  | { type: 'number'; text: string; depth: number }
  | { type: 'todo'; text: string; checked: boolean; depth: number }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string; language: string }
  | { type: 'divider' };

export interface MeetingNote {
  /** Notion page id */
  id: string;
  title: string;
  /** Meeting date: the DB's date property when present, else last_edited_time */
  dateMs: number;
  /** Raw last_edited_time ISO string — the incremental-sync comparison key */
  lastEditedIso: string;
  url: string;
  blocks: NoteBlock[];
  truncated: boolean;
}

/** → LocalSchema.meetingNotes. Device-local cache; '' lastError = healthy */
export interface MeetingNotesState {
  /** Sorted by dateMs desc */
  notes: MeetingNote[];
  fetchedAt: number;
  lastError: string;
}

export const MEETING_NOTES_DEFAULTS: MeetingNotesState = {
  notes: [],
  fetchedAt: 0,
  lastError: '',
};

/** 15 notes × 300 blocks stays well under the ~10MB storage.local quota */
export const MEETING_NOTES_MAX = 15;
export const MEETING_NOTE_MAX_BLOCKS = 300;
export const MEETING_NOTES_MAX_DEPTH = 3;

/** One database-query result row, before its content is fetched */
export interface PageMeta {
  id: string;
  title: string;
  dateMs: number;
  lastEditedIso: string;
  url: string;
}

interface ApiRichText {
  plain_text?: string;
}

interface ApiPage {
  id?: string;
  archived?: boolean;
  last_edited_time?: string;
  url?: string;
  properties?: Record<string, ApiProperty | undefined>;
}

interface ApiProperty {
  type?: string;
  title?: ApiRichText[];
  date?: { start?: string } | null;
}

function flattenRichText(spans: unknown): string {
  if (!Array.isArray(spans)) return '';
  return spans.map((s) => (s as ApiRichText)?.plain_text ?? '').join('');
}

/** One /query result row → metadata; null = skip (archived or malformed).
 * Title = the property whose type === 'title' (survives renames);
 * date = `dateProp` when set on the row, else last_edited_time. */
export function mapPageResult(raw: unknown, dateProp: string): PageMeta | null {
  const page = raw as ApiPage;
  if (!page || typeof page !== 'object' || !page.id || page.archived) return null;
  const editedMs = Date.parse(page.last_edited_time ?? '');
  if (Number.isNaN(editedMs)) return null;

  const props = page.properties ?? {};
  const titleProp = Object.values(props).find((p) => p?.type === 'title');
  const title = flattenRichText(titleProp?.title).trim() || '(untitled)';

  let dateMs = editedMs;
  if (dateProp) {
    const parsed = Date.parse(props[dateProp]?.date?.start ?? '');
    if (!Number.isNaN(parsed)) dateMs = parsed;
  }

  return {
    id: page.id,
    title,
    dateMs,
    lastEditedIso: page.last_edited_time ?? '',
    url: page.url ?? '',
  };
}

interface ApiBlock {
  type?: string;
  [key: string]: unknown;
}

/** One blocks/children item → simplified block; null = unsupported type.
 * Rich text is flattened to plain text; `depth` is stamped by the caller. */
export function mapBlock(raw: unknown, depth: number): NoteBlock | null {
  const block = raw as ApiBlock;
  if (!block || typeof block !== 'object' || typeof block.type !== 'string') return null;
  const data = block[block.type] as
    | { rich_text?: unknown; checked?: boolean; language?: string }
    | undefined;
  const text = flattenRichText(data?.rich_text);

  switch (block.type) {
    case 'heading_1':
      return { type: 'heading', level: 1, text };
    case 'heading_2':
      return { type: 'heading', level: 2, text };
    case 'heading_3':
      return { type: 'heading', level: 3, text };
    case 'paragraph':
      return { type: 'paragraph', text, depth };
    case 'bulleted_list_item':
      return { type: 'bullet', text, depth };
    case 'numbered_list_item':
      return { type: 'number', text, depth };
    case 'to_do':
      return { type: 'todo', text, checked: data?.checked === true, depth };
    case 'quote':
      return { type: 'quote', text };
    case 'code':
      return { type: 'code', text, language: data?.language ?? '' };
    case 'divider':
      return { type: 'divider' };
    default:
      return null; // images, tables, embeds, child pages, …
  }
}

/** Incremental sync: reuse cached blocks when last_edited_time is unchanged,
 * fetch new/changed pages, drop notes gone from the query. Order follows `fresh`. */
export function planSync(
  fresh: PageMeta[],
  cached: MeetingNote[],
): { reuse: MeetingNote[]; fetch: PageMeta[] } {
  const byId = new Map(cached.map((n) => [n.id, n]));
  const reuse: MeetingNote[] = [];
  const fetch: PageMeta[] = [];
  for (const meta of fresh) {
    const existing = byId.get(meta.id);
    if (existing && existing.lastEditedIso === meta.lastEditedIso) {
      reuse.push(existing);
    } else {
      fetch.push(meta);
    }
  }
  return { reuse, fetch };
}

/** Append `block` unless the note is full; returns false (and marks nothing)
 * once `MEETING_NOTE_MAX_BLOCKS` is reached so callers can stop fetching. */
export function appendCapped(blocks: NoteBlock[], block: NoteBlock): boolean {
  if (blocks.length >= MEETING_NOTE_MAX_BLOCKS) return false;
  blocks.push(block);
  return true;
}
