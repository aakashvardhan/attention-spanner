import { describe, expect, it } from 'vitest';
import {
  buildBrainDumpPage,
  buildLinkPage,
  buildReadingLogPage,
  buildTaskCompletePatch,
  buildTaskPage,
  chunkRichText,
  classifyFailure,
  enqueueInto,
  MAX_NOTION_QUEUE,
  noteTitle,
  type NotionPush,
} from './notion';
import type { BookmarkLink, BrainDumpNote, ReadingProgress, Task, VideoProgress } from './types';

const bookmark: BookmarkLink = {
  id: 'b1',
  url: 'https://example.com/post',
  title: 'Example Post',
  groupId: 'g1',
  createdAt: 1,
};

const baseNote: BrainDumpNote = {
  id: 'n1',
  rawText: 'Go to SF today\nAnd other things',
  status: 'structured',
  bullets: ['Go to SF for robotics club', 'DMV tomorrow'],
  proposedTasks: [
    { text: 'Go to DMV', addedTaskId: null },
    { text: 'Finish research tasks', addedTaskId: 't9' },
  ],
  createdAt: 1_700_000_000_000,
  structuredAt: 1_700_000_100_000,
};

const task: Task = {
  id: 't1',
  text: 'Re-apply for learners permit',
  createdAt: 1,
  completedAt: null,
  snoozedUntil: null,
  source: 'popup',
};

const articleProgress: ReadingProgress = {
  kind: 'article',
  url: 'https://blog.example.com/rl',
  title: 'RL Post',
  source: 'Example Blog',
  maxPercent: 95,
  activeSeconds: 600,
  firstOpenedAt: 1,
  updatedAt: 2,
  completedAt: Date.UTC(2026, 6, 5, 12, 0, 0),
  nudge: { count: 0, lastAt: 0, dismissed: false },
  feedItemId: null,
  scrollY: 100,
  pageHeight: 2000,
};

describe('buildLinkPage', () => {
  it('maps title, url, and group name to a Tags multi_select', () => {
    const body = buildLinkPage(bookmark, '📚 Learning', 'db1');
    expect(body.parent).toEqual({ database_id: 'db1' });
    expect(body.properties.title).toEqual({ title: [{ text: { content: 'Example Post' } }] });
    expect(body.properties['URL']).toEqual({ url: 'https://example.com/post' });
    expect(body.properties['Tags']).toEqual({ multi_select: [{ name: '📚 Learning' }] });
  });

  it('omits Tags when ungrouped and falls back to url as title', () => {
    const body = buildLinkPage({ ...bookmark, title: '' }, null, 'db1');
    expect(body.properties['Tags']).toBeUndefined();
    expect(body.properties.title).toEqual({
      title: [{ text: { content: 'https://example.com/post' } }],
    });
  });

  it('uses detected property names and skips empty ones', () => {
    const body = buildLinkPage(bookmark, '📚 Learning', 'db1', 'Link', '');
    expect(body.properties['Link']).toEqual({ url: 'https://example.com/post' });
    expect(body.properties['URL']).toBeUndefined();
    expect(body.properties['Tags']).toBeUndefined();
  });
});

describe('noteTitle / buildBrainDumpPage', () => {
  it('uses the first non-empty line, truncated to 80 chars', () => {
    expect(noteTitle(baseNote)).toBe('Go to SF today');
    const long = { ...baseNote, rawText: 'x'.repeat(200) };
    expect(noteTitle(long)).toHaveLength(80);
    expect(noteTitle(long).endsWith('…')).toBe(true);
  });

  it('falls back to a date for whitespace-only text', () => {
    const blank = { ...baseNote, rawText: '  \n  ' };
    expect(noteTitle(blank)).toBe(new Date(baseNote.createdAt).toLocaleDateString());
  });

  it('orders children: raw paragraph, bullets, unchecked to_dos', () => {
    const body = buildBrainDumpPage(baseNote, 'db2');
    const children = body.children as Record<string, unknown>[];
    expect(children).toHaveLength(1 + 2 + 2);
    expect(children[0]).toHaveProperty('paragraph');
    expect(children[1]).toHaveProperty('bulleted_list_item');
    expect(children[3]).toHaveProperty('to_do');
    expect((children[3] as { to_do: { checked: boolean } }).to_do.checked).toBe(false);
  });

  it('renders a raw-only note as a single paragraph', () => {
    const raw = { ...baseNote, status: 'raw' as const, bullets: [], proposedTasks: [] };
    const body = buildBrainDumpPage(raw, 'db2');
    expect(body.children).toHaveLength(1);
  });

  it('chunks raw text past 2000 chars', () => {
    const chunks = chunkRichText('a'.repeat(4100));
    expect(chunks).toHaveLength(3);
    expect(chunks[0].text.content).toHaveLength(2000);
    expect(chunks[2].text.content).toHaveLength(100);
  });
});

describe('task builders', () => {
  it('creates a title-only page', () => {
    const body = buildTaskPage(task, 'db3');
    expect(body).toEqual({
      parent: { database_id: 'db3' },
      properties: { title: { title: [{ text: { content: task.text } }] } },
    });
  });

  it('patches the detected checkbox property both ways', () => {
    expect(buildTaskCompletePatch('Done', true)).toEqual({
      properties: { Done: { checkbox: true } },
    });
    expect(buildTaskCompletePatch('Complete', false)).toEqual({
      properties: { Complete: { checkbox: false } },
    });
  });
});

describe('buildReadingLogPage', () => {
  it('logs an article with URL, Type, and Finished date', () => {
    const body = buildReadingLogPage(articleProgress, 'db4');
    expect(body.properties['Type']).toEqual({ select: { name: 'Article' } });
    expect(body.properties['URL']).toEqual({ url: articleProgress.url });
    expect(body.properties['Finished']).toEqual({ date: { start: '2026-07-05' } });
  });

  it('marks videos as Video', () => {
    const video: VideoProgress = {
      ...articleProgress,
      kind: 'video',
      videoId: 'abc',
      durationSeconds: 100,
      positionSeconds: 95,
    };
    const body = buildReadingLogPage(video, 'db4');
    expect(body.properties['Type']).toEqual({ select: { name: 'Video' } });
  });
});

describe('queue helpers', () => {
  const item = (id: string): NotionPush => ({
    id,
    kind: 'link',
    method: 'POST',
    path: '/v1/pages',
    body: {},
    createdAt: 1,
    attempts: 0,
  });

  it('caps the queue by dropping the oldest entries', () => {
    let queue: NotionPush[] = [];
    for (let i = 0; i < MAX_NOTION_QUEUE + 5; i++) queue = enqueueInto(queue, item(`i${i}`));
    expect(queue).toHaveLength(MAX_NOTION_QUEUE);
    expect(queue[0].id).toBe('i5');
    expect(queue.at(-1)?.id).toBe(`i${MAX_NOTION_QUEUE + 4}`);
  });

  it('classifies failures: 401 auth, 400/404 fatal, rest retryable', () => {
    expect(classifyFailure(401)).toBe('auth');
    expect(classifyFailure(400)).toBe('fatal');
    expect(classifyFailure(404)).toBe('fatal');
    expect(classifyFailure(429)).toBe('retryable');
    expect(classifyFailure(500)).toBe('retryable');
    expect(classifyFailure(null)).toBe('retryable');
  });
});
