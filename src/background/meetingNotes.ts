import { MEETING_NOTES_THROTTLE_MS } from '../shared/constants';
import {
  appendCapped,
  mapBlock,
  mapPageResult,
  MEETING_NOTES_MAX,
  MEETING_NOTES_MAX_DEPTH,
  planSync,
  type MeetingNote,
  type NoteBlock,
  type PageMeta,
} from '../shared/meetingNotes';
import { getLocal, getSettings, setLocal } from '../shared/storage';
import { notionFetch } from './notion';

/**
 * Notion meeting-notes pull — the read counterpart to the push queue in
 * notion.ts. Reads are idempotent and periodic, so no queue: query the picked
 * database, fetch blocks only for new/changed pages (planSync), cache into
 * LocalSchema.meetingNotes. Pure mapping in src/shared/meetingNotes.ts.
 */

const REQUEST_SPACING_MS = 350; // same ~3 req/s headroom as the push path

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readError(response: Response): Promise<string> {
  const err = (await response.json().catch(() => ({}))) as { message?: string };
  return err.message ?? `Notion request failed (HTTP ${response.status})`;
}

interface BlockListResponse {
  results?: unknown[];
  has_more?: boolean;
  next_cursor?: string | null;
}

/** Depth-first block walk: children flatten in reading order right after their
 * parent. Stops (returns truncated=true) once the per-note block cap is hit. */
async function fetchBlocks(token: string, pageId: string): Promise<{
  blocks: NoteBlock[];
  truncated: boolean;
}> {
  const blocks: NoteBlock[] = [];
  let truncated = false;

  const walk = async (blockId: string, depth: number): Promise<void> => {
    let cursor: string | undefined;
    do {
      if (truncated) return;
      const query = cursor ? `?page_size=100&start_cursor=${cursor}` : '?page_size=100';
      const response = await notionFetch(token, 'GET', `/v1/blocks/${blockId}/children${query}`);
      if (!response.ok) throw new Error(await readError(response));
      const json = (await response.json()) as BlockListResponse;

      for (const raw of json.results ?? []) {
        const mapped = mapBlock(raw, depth);
        if (mapped && !appendCapped(blocks, mapped)) {
          truncated = true;
          return;
        }
        const child = raw as { id?: string; has_children?: boolean };
        if (child.has_children && child.id && depth + 1 < MEETING_NOTES_MAX_DEPTH) {
          await sleep(REQUEST_SPACING_MS);
          await walk(child.id, depth + 1);
          if (truncated) return;
        }
      }
      cursor = json.has_more && json.next_cursor ? json.next_cursor : undefined;
      if (cursor) await sleep(REQUEST_SPACING_MS);
    } while (cursor);
  };

  await walk(pageId, 0);
  return { blocks, truncated };
}

async function queryDatabase(
  token: string,
  dbId: string,
  dateProp: string,
): Promise<PageMeta[]> {
  const sorts = dateProp
    ? [{ property: dateProp, direction: 'descending' }]
    : [{ timestamp: 'last_edited_time', direction: 'descending' }];
  const response = await notionFetch(token, 'POST', `/v1/databases/${dbId}/query`, {
    page_size: MEETING_NOTES_MAX,
    sorts,
  });
  if (!response.ok) throw new Error(await readError(response));
  const json = (await response.json()) as { results?: unknown[] };
  return (json.results ?? [])
    .map((raw) => mapPageResult(raw, dateProp))
    .filter((m): m is PageMeta => m !== null);
}

let refreshing: Promise<{ ok: boolean; error?: string }> | null = null;

/**
 * Pull recent notes from the configured meeting-notes database. No-ops when
 * unconfigured, and throttles unforced calls so a newtab-open refresh can't
 * hammer the API. Unchanged pages (same last_edited_time) reuse cached blocks,
 * so a quiet database costs one request per poll.
 */
export function refreshMeetingNotes(force = false): Promise<{ ok: boolean; error?: string }> {
  refreshing ??= doRefresh(force).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function doRefresh(force: boolean): Promise<{ ok: boolean; error?: string }> {
  const settings = await getSettings();
  if (!settings.notionToken || !settings.notionMeetingNotesDbId) return { ok: true };
  const { meetingNotes } = await getLocal('meetingNotes');
  if (!force && Date.now() - meetingNotes.fetchedAt < MEETING_NOTES_THROTTLE_MS) {
    return { ok: true };
  }

  try {
    const fresh = await queryDatabase(
      settings.notionToken,
      settings.notionMeetingNotesDbId,
      settings.notionMeetingNotesDateProp,
    );
    const { reuse, fetch } = planSync(fresh, meetingNotes.notes);

    const fetched: MeetingNote[] = [];
    for (const meta of fetch) {
      await sleep(REQUEST_SPACING_MS);
      const { blocks, truncated } = await fetchBlocks(settings.notionToken, meta.id);
      fetched.push({ ...meta, blocks, truncated });
    }

    const notes = [...reuse, ...fetched]
      .sort((a, b) => b.dateMs - a.dateMs)
      .slice(0, MEETING_NOTES_MAX);
    await setLocal({ meetingNotes: { notes, fetchedAt: Date.now(), lastError: '' } });
    return { ok: true };
  } catch (error) {
    const message = (error as Error).message ?? 'Meeting notes refresh failed.';
    const { meetingNotes: latest } = await getLocal('meetingNotes');
    await setLocal({ meetingNotes: { ...latest, lastError: message } });
    return { ok: false, error: message };
  }
}
