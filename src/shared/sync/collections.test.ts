import { describe, expect, it } from 'vitest';
import {
  diffIds,
  mergeFeeds,
  mergeGymCheckins,
  mergeReadingProgress,
  mergeRecordCollection,
  mergeSrsDaily,
  mergeStreakDaily,
  mergeTombstones,
  RECORD_COLLECTIONS,
  sweepTombstoneMap,
  tombstoneKey,
} from './collections';
import { live } from './merge';
import type { DayStats, ReadingProgress, SrsDayStats, Task } from '../types';

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  text: id,
  createdAt: 1,
  completedAt: null,
  snoozedUntil: null,
  source: 'popup',
  updatedAt: 1,
  deletedAt: null,
  ...over,
});

describe('RECORD_COLLECTIONS', () => {
  it('lists the id-addressable synced collections with no duplicates', () => {
    expect(new Set(RECORD_COLLECTIONS).size).toBe(RECORD_COLLECTIONS.length);
    expect(RECORD_COLLECTIONS).toContain('tasks');
    expect(RECORD_COLLECTIONS).toContain('flashCards');
  });
});

describe('mergeRecordCollection', () => {
  it('LWW-merges and keeps tombstones out of live()', () => {
    const local = [task('a', { text: 'local', updatedAt: 5 }), task('b')];
    const remote = [
      task('a', { text: 'remote', updatedAt: 9 }),
      task('b', { updatedAt: 9, deletedAt: 9 }),
    ];
    const merged = mergeRecordCollection(local, remote);
    expect(merged.find((t) => t.id === 'a')!.text).toBe('remote');
    expect(live(merged).map((t) => t.id)).toEqual(['a']);
  });
});

describe('aggregate merges', () => {
  it('unions feeds', () => {
    expect(mergeFeeds(['x'], ['x', 'y'])).toEqual(['x', 'y']);
  });

  it('per-day maxes streak daily stats', () => {
    const a: Record<string, DayStats> = { '2026-07-09': { minutes: 10, sprints: 1, articlesFinished: 0 } };
    const b: Record<string, DayStats> = { '2026-07-09': { minutes: 4, sprints: 3, articlesFinished: 1 } };
    expect(mergeStreakDaily(a, b)['2026-07-09']).toMatchObject({ minutes: 10, sprints: 3, articlesFinished: 1 });
  });

  it('per-day per-deck maxes srsDaily', () => {
    const a: Record<string, SrsDayStats> = { '2026-07-09': { reviews: { d1: 5 }, newIntroduced: {} } };
    const b: Record<string, SrsDayStats> = { '2026-07-09': { reviews: { d1: 2, d2: 1 }, newIntroduced: { d1: 3 } } };
    expect(mergeSrsDaily(a, b)['2026-07-09']).toEqual({ reviews: { d1: 5, d2: 1 }, newIntroduced: { d1: 3 } });
  });

  it('per-day maxes gym check-ins', () => {
    expect(mergeGymCheckins({ '2026-07-09': 100 }, { '2026-07-09': 200 })).toEqual({ '2026-07-09': 200 });
  });

  it('per-url merges reading progress', () => {
    const url = 'https://example.com/a';
    const mk = (over: Partial<ReadingProgress>): ReadingProgress => ({
      kind: 'article',
      url,
      title: 'A',
      source: 'Feed',
      maxPercent: 0,
      activeSeconds: 0,
      firstOpenedAt: 1,
      updatedAt: 1,
      completedAt: null,
      nudge: { count: 0, lastAt: 0, dismissed: false },
      feedItemId: null,
      scrollY: 0,
      pageHeight: 0,
      ...over,
    });
    const merged = mergeReadingProgress({ [url]: mk({ maxPercent: 30 }) }, { [url]: mk({ maxPercent: 80 }) });
    expect(merged[url].maxPercent).toBe(80);
  });
});

describe('tombstones', () => {
  it('builds a collection-scoped key', () => {
    expect(tombstoneKey('tasks', 'abc')).toBe('tasks:abc');
    expect(tombstoneKey('flashCards', 'n1#0')).toBe('flashCards:n1#0');
  });

  it('diffs added and removed ids', () => {
    const before = [task('a'), task('b'), task('c')];
    const after = [task('a'), task('c'), task('d')];
    expect(diffIds(before, after)).toEqual({ added: ['d'], removed: ['b'] });
  });

  it('merges tombstone maps keeping the latest deletion', () => {
    expect(mergeTombstones({ 'tasks:a': 100, 'tasks:b': 5 }, { 'tasks:a': 80, 'tasks:c': 9 })).toEqual({
      'tasks:a': 100,
      'tasks:b': 5,
      'tasks:c': 9,
    });
  });

  it('sweeps tombstones past the TTL', () => {
    const now = 1_000_000;
    const map = { 'tasks:old': now - 200, 'tasks:fresh': now - 50 };
    expect(sweepTombstoneMap(map, now, 100)).toEqual({ 'tasks:fresh': now - 50 });
  });
});
