import { describe, expect, it } from 'vitest';
import {
  appendCapped,
  mapBlock,
  mapPageResult,
  MEETING_NOTE_MAX_BLOCKS,
  planSync,
  type MeetingNote,
  type NoteBlock,
  type PageMeta,
} from './meetingNotes';

function rt(...texts: string[]) {
  return texts.map((t) => ({ plain_text: t }));
}

const basePage = {
  id: 'p1',
  archived: false,
  last_edited_time: '2026-07-15T10:00:00.000Z',
  url: 'https://www.notion.so/p1',
  properties: {
    Name: { type: 'title', title: rt('Weekly sync') },
    Date: { type: 'date', date: { start: '2026-07-14' } },
  },
};

describe('mapPageResult', () => {
  it('maps a row with a date property', () => {
    const meta = mapPageResult(basePage, 'Date');
    expect(meta).toEqual({
      id: 'p1',
      title: 'Weekly sync',
      dateMs: Date.parse('2026-07-14'),
      lastEditedIso: '2026-07-15T10:00:00.000Z',
      url: 'https://www.notion.so/p1',
    });
  });

  it('finds the title property by type even when renamed', () => {
    const page = {
      ...basePage,
      properties: { 'Meeting title': { type: 'title', title: rt('Standup') } },
    };
    expect(mapPageResult(page, '')?.title).toBe('Standup');
  });

  it('falls back to last_edited_time when dateProp is empty or unset on the row', () => {
    const edited = Date.parse(basePage.last_edited_time);
    expect(mapPageResult(basePage, '')?.dateMs).toBe(edited);
    const noDate = {
      ...basePage,
      properties: { ...basePage.properties, Date: { type: 'date', date: null } },
    };
    expect(mapPageResult(noDate, 'Date')?.dateMs).toBe(edited);
  });

  it('uses (untitled) for empty titles', () => {
    const page = { ...basePage, properties: { Name: { type: 'title', title: rt('  ') } } };
    expect(mapPageResult(page, '')?.title).toBe('(untitled)');
  });

  it('skips archived and malformed rows', () => {
    expect(mapPageResult({ ...basePage, archived: true }, '')).toBeNull();
    expect(mapPageResult({ ...basePage, id: undefined }, '')).toBeNull();
    expect(mapPageResult({ ...basePage, last_edited_time: 'nope' }, '')).toBeNull();
    expect(mapPageResult(null, '')).toBeNull();
    expect(mapPageResult('junk', '')).toBeNull();
  });
});

describe('mapBlock', () => {
  it('maps every supported type', () => {
    expect(mapBlock({ type: 'heading_1', heading_1: { rich_text: rt('H1') } }, 0)).toEqual({
      type: 'heading',
      level: 1,
      text: 'H1',
    });
    expect(mapBlock({ type: 'heading_2', heading_2: { rich_text: rt('H2') } }, 0)).toEqual({
      type: 'heading',
      level: 2,
      text: 'H2',
    });
    expect(mapBlock({ type: 'heading_3', heading_3: { rich_text: rt('H3') } }, 0)).toEqual({
      type: 'heading',
      level: 3,
      text: 'H3',
    });
    expect(mapBlock({ type: 'paragraph', paragraph: { rich_text: rt('hi') } }, 1)).toEqual({
      type: 'paragraph',
      text: 'hi',
      depth: 1,
    });
    expect(
      mapBlock({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt('b') } }, 2),
    ).toEqual({ type: 'bullet', text: 'b', depth: 2 });
    expect(
      mapBlock({ type: 'numbered_list_item', numbered_list_item: { rich_text: rt('n') } }, 0),
    ).toEqual({ type: 'number', text: 'n', depth: 0 });
    expect(
      mapBlock({ type: 'to_do', to_do: { rich_text: rt('task'), checked: true } }, 0),
    ).toEqual({ type: 'todo', text: 'task', checked: true, depth: 0 });
    expect(mapBlock({ type: 'to_do', to_do: { rich_text: rt('task') } }, 0)).toEqual({
      type: 'todo',
      text: 'task',
      checked: false,
      depth: 0,
    });
    expect(mapBlock({ type: 'quote', quote: { rich_text: rt('q') } }, 0)).toEqual({
      type: 'quote',
      text: 'q',
    });
    expect(
      mapBlock({ type: 'code', code: { rich_text: rt('x=1'), language: 'python' } }, 0),
    ).toEqual({ type: 'code', text: 'x=1', language: 'python' });
    expect(mapBlock({ type: 'divider', divider: {} }, 0)).toEqual({ type: 'divider' });
  });

  it('flattens multi-span rich text', () => {
    const block = { type: 'paragraph', paragraph: { rich_text: rt('one ', 'two ', 'three') } };
    expect(mapBlock(block, 0)).toEqual({ type: 'paragraph', text: 'one two three', depth: 0 });
  });

  it('returns null for unsupported and malformed blocks', () => {
    expect(mapBlock({ type: 'image', image: {} }, 0)).toBeNull();
    expect(mapBlock({ type: 'table', table: {} }, 0)).toBeNull();
    expect(mapBlock({ type: 'child_page', child_page: {} }, 0)).toBeNull();
    expect(mapBlock(null, 0)).toBeNull();
    expect(mapBlock({}, 0)).toBeNull();
  });
});

function note(id: string, lastEditedIso: string): MeetingNote {
  return { id, title: id, dateMs: 0, lastEditedIso, url: '', blocks: [], truncated: false };
}

function meta(id: string, lastEditedIso: string): PageMeta {
  return { id, title: id, dateMs: 0, lastEditedIso, url: '' };
}

describe('planSync', () => {
  it('reuses unchanged, fetches changed and new, drops absent', () => {
    const cached = [note('a', 't1'), note('b', 't1'), note('gone', 't1')];
    const fresh = [meta('a', 't1'), meta('b', 't2'), meta('new', 't1')];
    const { reuse, fetch } = planSync(fresh, cached);
    expect(reuse.map((n) => n.id)).toEqual(['a']);
    expect(fetch.map((m) => m.id)).toEqual(['b', 'new']);
  });

  it('handles empty caches and empty results', () => {
    expect(planSync([meta('a', 't1')], []).fetch).toHaveLength(1);
    const { reuse, fetch } = planSync([], [note('a', 't1')]);
    expect(reuse).toEqual([]);
    expect(fetch).toEqual([]);
  });
});

describe('appendCapped', () => {
  it('stops appending at MEETING_NOTE_MAX_BLOCKS', () => {
    const blocks: NoteBlock[] = [];
    const block: NoteBlock = { type: 'divider' };
    for (let i = 0; i < MEETING_NOTE_MAX_BLOCKS; i++) {
      expect(appendCapped(blocks, block)).toBe(true);
    }
    expect(appendCapped(blocks, block)).toBe(false);
    expect(blocks).toHaveLength(MEETING_NOTE_MAX_BLOCKS);
  });
});
