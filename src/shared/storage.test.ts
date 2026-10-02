import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  v12ReadingProgress,
  v22StripSettings,
  v7Annotations,
  V22_DEAD_KEYS,
  V22_DEAD_SETTINGS,
} from './storage';
import type { Settings } from './types';

/**
 * v6 → v7's surviving half: annotations grew an anchor union when the reader
 * learned to read articles, so every record from before then is a PDF one.
 */
describe('v7Annotations', () => {
  it('wraps pdf annotations into the anchor union', () => {
    const converted = v7Annotations([
      {
        id: 'a',
        docKey: 'k',
        pdfUrl: 'https://arxiv.org/pdf/1',
        paperId: 'p1',
        kind: 'highlight',
        page: 4,
        rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }],
        x: 0,
        y: 0,
        text: 'quoted',
        color: 'yellow',
        note: '',
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    expect(converted).toEqual([
      {
        id: 'a',
        docKey: 'k',
        docUrl: 'https://arxiv.org/pdf/1',
        paperId: 'p1',
        kind: 'highlight',
        anchor: {
          kind: 'pdf',
          page: 4,
          rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }],
          x: 0,
          y: 0,
        },
        text: 'quoted',
        color: 'yellow',
        note: '',
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
  });

  it('returns null when there is nothing to convert', () => {
    expect(v7Annotations([])).toBeNull();
    expect(v7Annotations(undefined)).toBeNull();
  });
});

describe('v12ReadingProgress', () => {
  const entry = (over: Record<string, unknown>) =>
    ({ title: 'A post', url: 'https://example.com/a', maxPercent: 20, ...over }) as never;

  it('restores the article URL from the reader link and drops the "Reader" name', () => {
    const repaired = v12ReadingProgress({
      'example.com/a': entry({
        title: 'Reader',
        url: 'chrome-extension://abc/src/pages/reader/index.html?article=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1',
      }),
    });
    expect(repaired?.['example.com/a']).toMatchObject({
      title: '',
      url: 'https://example.com/a?x=1',
      maxPercent: 20,
    });
  });

  it('handles the PDF reader link too, keeping a real title', () => {
    const repaired = v12ReadingProgress({
      'example.com/p': entry({
        title: 'A paper',
        url: 'chrome-extension://abc/src/pages/reader/index.html?src=https%3A%2F%2Fexample.com%2Fp.pdf',
      }),
    });
    expect(repaired?.['example.com/p']).toMatchObject({
      title: 'A paper',
      url: 'https://example.com/p.pdf',
    });
  });

  it('returns null when nothing is corrupted, so a clean profile is not rewritten', () => {
    expect(v12ReadingProgress({ 'example.com/a': entry({}) })).toBeNull();
    expect(v12ReadingProgress({})).toBeNull();
  });

  it('leaves videos alone', () => {
    expect(
      v12ReadingProgress({
        'yt:abc': entry({ kind: 'video', url: 'https://www.youtube.com/watch?v=abc' }),
      }),
    ).toBeNull();
  });
});

/*
 * The skin setting is gone, but patchSettings persisted whole settings
 * objects for months, so real profiles still carry `skin`. It must be inert.
 */
describe('a stored settings object from before the skins were retired', () => {
  it('merges over the defaults without resurrecting skin as a known field', () => {
    const merged = { ...DEFAULT_SETTINGS, ...({ skin: 'alert', focusMinutes: 25 } as Partial<Settings>) };
    expect(merged.focusMinutes).toBe(25);
    expect('skin' in DEFAULT_SETTINGS).toBe(false);
  });
});


/**
 * v21 → v22 is the sweep that follows cutting every feature Notion already
 * covers. It is cumulative on purpose — it carries the keys v13, v20 and v21
 * retired too — so a profile jumping straight from an old version lands clean.
 */
describe('v22', () => {
  it('names only keys whose feature is gone, and keeps the ones that are not', () => {
    for (const dead of ['tasks', 'notes', 'jobs', 'recordings', 'gmail', 'calendar', 'streaks']) {
      expect(V22_DEAD_KEYS).toContain(dead);
    }
    // The surviving collections must never appear here: this list is passed
    // straight to storage.remove, so a stray entry is silent data loss.
    for (const alive of [
      'feeds',
      'readItems',
      'cachedItems',
      'settings',
      'readingProgress',
      'bookmarks',
      'bookmarkGroups',
      'decks',
      'papers',
      'annotations',
      'focusSession',
      'schemaVersion',
    ]) {
      expect(V22_DEAD_KEYS).not.toContain(alive);
    }
  });

  it('carries the keys the earlier sweeps retired, so one pass is enough', () => {
    for (const legacy of ['notionQueue', 'notionStatus', 'dailyBrainDumpGate', 'flashCards']) {
      expect(V22_DEAD_KEYS).toContain(legacy);
    }
  });

  it('strips the dead settings and leaves everything else untouched', () => {
    const next = v22StripSettings({
      theme: 'dark',
      focusMinutes: 50,
      geminiApiKey: 'secret',
      assistantEnabled: true,
      taskReminderIntervalMinutes: 60,
      timePillHosts: ['youtube.com'],
      gmailTriageTime: '08:30',
    });
    expect(next).toEqual({ theme: 'dark', focusMinutes: 50 });
  });

  // Derived from DEFAULT_SETTINGS rather than listed by hand: a hand-written
  // list silently stops covering the settings added after it, which is exactly
  // when this guard matters. Every live setting is every key with a default.
  it('never names a setting the extension still reads', () => {
    for (const alive of Object.keys(DEFAULT_SETTINGS)) {
      expect(V22_DEAD_SETTINGS).not.toContain(alive);
    }
  });

  it('sweeps what v23 retired: the daily focus and the Pomodoro break length', () => {
    expect(V22_DEAD_KEYS).toContain('focusOfDay');
    expect(v22StripSettings({ focusMinutes: 50, focusBreakMinutes: 10 })).toEqual({
      focusMinutes: 50,
    });
  });

  it('is a no-op on a profile that never stored settings', () => {
    expect(v22StripSettings(undefined)).toBeNull();
  });

  it('leaves a settings object that carries none of the dead fields alone', () => {
    expect(v22StripSettings({ theme: 'light' })).toEqual({ theme: 'light' });
  });
});
