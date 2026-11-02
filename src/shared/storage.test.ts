import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DEFAULTS,
  migrate,
  SCHEMA_VERSION,
  v24Dumps,
  v27Annotations,
  v27FocusSession,
  v27Papers,
  withDumpLock,
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

/*
 * The skin setting is gone, but patchSettings persisted whole settings
 * objects for months, so real profiles still carry `skin`. It must be inert.
 */
describe('a stored settings object from before the skins were retired', () => {
  it('merges over the defaults without resurrecting skin as a known field', () => {
    const merged = { ...DEFAULT_SETTINGS, ...({ skin: 'alert', readerFocusLine: true } as Partial<Settings>) };
    expect(merged.readerFocusLine).toBe(true);
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
    for (const dead of ['tasks', 'notes', 'jobs', 'recordings', 'gmail', 'calendar', 'streaks', 'bookmarks', 'bookmarkGroups']) {
      expect(V22_DEAD_KEYS).toContain(dead);
    }
    // The surviving collections must never appear here: this list is passed
    // straight to storage.remove, so a stray entry is silent data loss.
    for (const alive of [
      'settings',
      'folders',
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
      claudeKey: 'k',
      focusMinutes: 50,
      geminiApiKey: 'secret',
      assistantEnabled: true,
      taskReminderIntervalMinutes: 60,
      timePillHosts: ['youtube.com'],
      gmailTriageTime: '08:30',
    });
    expect(next).toEqual({ claudeKey: 'k' });
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
    expect(v22StripSettings({ claudeKey: 'k', focusBreakMinutes: 10 })).toEqual({ claudeKey: 'k' });
  });

  it('sweeps what v25 retired: the masthead\'s weather, name and runners', () => {
    expect(V22_DEAD_KEYS).toContain('weather');
    for (const k of ['displayName', 'weatherLocation', 'ambientMotion']) expect(V22_DEAD_SETTINGS).toContain(k);
    expect(
      v22StripSettings({ displayName: 'A', weatherLocation: 'X', ambientMotion: true, claudeKey: 'k' }),
    ).toEqual({ claudeKey: 'k' });
  });

  it('sweeps what v25 retired: the hyperfocus check-in', () => {
    expect(V22_DEAD_SETTINGS).toContain('hyperfocusEnabled');
    expect(v22StripSettings({ hyperfocusEnabled: true, claudeKey: 'k' })).toEqual({ claudeKey: 'k' });
  });

  it('sweeps what v25 retired: Flowtunes, the Gemini key and the AI stats', () => {
    expect(V22_DEAD_KEYS).toContain('aiStats');
    for (const k of ['focusMusicEnabled', 'geminiKey']) expect(V22_DEAD_SETTINGS).toContain(k);
    expect(v22StripSettings({ focusMusicEnabled: true, geminiKey: 'k', claudeKey: 'k' })).toEqual({ claudeKey: 'k' });
  });

  it('sweeps what v28 retired: the theme choice and night mode (one walnut theme now)', () => {
    expect(v22StripSettings({ theme: 'paperwhite', readerNight: true, claudeKey: 'k' })).toEqual({ claudeKey: 'k' });
  });

  it('sweeps what v27 retired: feeds, video, topics, local AI, decks, provocations, Pomodoro', () => {
    for (const k of ['feeds', 'readItems', 'cachedItems', 'readingProgress', 'aiVectors', 'layaRoles', 'provocations', 'decks'])
      expect(V22_DEAD_KEYS).toContain(k);
    expect(
      v22StripSettings({ claudeKey: 'k', geminiTopicKey: 'k', ollamaUrl: 'u', cloudMode: 'all', focusMinutes: 50, mutedTopics: [] }),
    ).toEqual({ claudeKey: 'k' });
  });

  // Session storage survives an extension update, so the dead keys go on every
  // startup, even for a profile already on the current version.
  it('clears the retired session keys even when migration returns early', async () => {
    const remove = vi.fn(() => Promise.resolve());
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: () => Promise.resolve({ schemaVersion: SCHEMA_VERSION }), set: vi.fn(), remove: vi.fn() },
        session: { remove },
      },
    });
    await migrate();
    vi.unstubAllGlobals();
    expect(remove).toHaveBeenCalledWith(['hyperfocus', 'driftChecked', 'lastGlobalNudgeAt']);
  });

  it('is a no-op on a profile that never stored settings', () => {
    expect(v22StripSettings(undefined)).toBeNull();
  });

  it('returns null for stored settings that are not an object, and {} for {}', () => {
    expect(v22StripSettings(null as never)).toBeNull();
    expect(v22StripSettings('string' as never)).toBeNull();
    expect(v22StripSettings({})).toEqual({});
  });

  it('leaves a settings object that carries none of the dead fields alone', () => {
    expect(v22StripSettings({ claudeKey: 'x' })).toEqual({ claudeKey: 'x' });
  });
});

describe('schema', () => {
  it('starts at 28 with an empty shelf and push queue', () => {
    expect(DEFAULTS.schemaVersion).toBe(28);
    expect(DEFAULTS.folders).toEqual([]);
    expect(DEFAULTS.alphaxivPush).toEqual([]);
  });
});

/** v23 → v24: the dump stops being a task engine; only the words you wrote survive, to be locked at setup. */
describe('v24Dumps', () => {
  it('keeps roots only and strips the task fields', () => {
    expect(
      v24Dumps([
        { id: 'r', text: 'raw', createdAt: 1, nextStep: 's', kind: 'task' },
        { id: 'p', text: 'point', createdAt: 2, parentId: 'r', quadrant: 'do' },
      ]),
    ).toEqual([{ id: 'r', text: 'raw', createdAt: 1 }]);
  });

  it('gives a malformed record a usable id and date', () => {
    const [d] = v24Dumps([{ text: 'no id or date' }]);
    expect(d.createdAt).toBe(0);
    expect(d.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('starts the vault empty', () => {
    expect(DEFAULTS.vault).toBeNull();
    expect(DEFAULTS.lockedDumps).toEqual([]);
  });
});

/** Two tabs saving a dump at once each read, seal, then write the list; without the lock one write loses the other. */
describe('withDumpLock', () => {
  it('runs read-modify-writes one at a time', async () => {
    let list: string[] = [];
    const add = (x: string) =>
      withDumpLock(async () => {
        const seen = list;
        await new Promise((r) => setTimeout(r, 10));
        list = [...seen, x];
      });
    await Promise.all([add('a'), add('b')]);
    expect(list.sort()).toEqual(['a', 'b']);
  });
});

const KEPT_LOCAL_KEYS = ['schemaVersion','settings','focusSession','folders','papers','alphaxivPush','annotations',
  'aiCache','activity','dumps','vault','lockedDumps'] as const;
describe('kept data', () => {
  it('every kept key still has a default', () => { for (const k of KEPT_LOCAL_KEYS) expect(DEFAULTS).toHaveProperty(k); });
  it('no kept key is ever swept', () => { for (const k of KEPT_LOCAL_KEYS) expect(V22_DEAD_KEYS).not.toContain(k); });
  it('no live setting is ever swept', () => { for (const k of Object.keys(DEFAULT_SETTINGS)) expect(V22_DEAD_SETTINGS).not.toContain(k); });
  it('no live local key is ever swept', () => { for (const k of Object.keys(DEFAULTS)) expect(V22_DEAD_KEYS).not.toContain(k); });
});

describe('v27Papers', () => {
  const decks = [{ id: 'd1', name: 'Diffusion' }, { id: 'd2', name: 'Robotics' }];
  const old = (over: Record<string, unknown>) => ({
    id: 'x', deckId: 'd1', title: 'T', authors: 'A', venue: 'V', year: 2020, citations: 3, abstract: 'ab',
    relevance: 'r', status: 'reading', pass: 2, progressPercent: 40, leftOff: '§3', addedAt: 1, updatedAt: 2, lastReadAt: 3,
    url: 'https://arxiv.org/abs/2006.11239v2', ...over,
  });

  it('keeps an arXiv paper, re-keyed by id, with its reading state and nothing else', () => {
    const { papers, push } = v27Papers([old({})], decks);
    expect(papers).toEqual([
      {
        id: '2006.11239', title: 'T', authors: 'A', year: 2020, url: 'https://arxiv.org/abs/2006.11239',
        folderIds: [], progressPercent: 40, leftOff: '§3', addedAt: 1, updatedAt: 2, lastReadAt: 3,
      },
    ]);
    expect(push).toEqual([{ id: '2006.11239', folder: 'Diffusion' }]);
  });

  it('finds the arXiv id through the saved PDF url when the link is not arXiv', () => {
    const pdf = { url: 'https://arxiv.org/pdf/2406.09246', page: 3, pageCount: 20, offset: 0.2 };
    const { papers } = v27Papers([old({ url: 'https://openvla.github.io', pdf })], decks);
    expect(papers[0]).toMatchObject({ id: '2406.09246', pdf });
  });

  it('drops DOI, plain-web and malformed papers', () => {
    const { papers, push } = v27Papers(
      [old({ url: 'https://doi.org/10.1145/3290605' }), old({ url: 'https://example.com/p.pdf' }), null, 'junk', 7],
      decks,
    );
    expect(papers).toEqual([]);
    expect(push).toEqual([]);
  });

  it('keeps the first of two records for the same paper', () => {
    const { papers, push } = v27Papers([old({ deckId: 'd1' }), old({ deckId: 'd2', url: 'https://arxiv.org/pdf/2006.11239' })], decks);
    expect(papers).toHaveLength(1);
    expect(push).toEqual([{ id: '2006.11239', folder: 'Diffusion' }]);
  });

  it('files a paper whose deck is gone under Want to read, and titles an untitled one by id', () => {
    const { papers, push } = v27Papers([old({ deckId: 'missing', title: '' })], decks);
    expect(push[0].folder).toBe('Want to read');
    expect(papers[0].title).toBe('2006.11239');
  });
});

describe('v27Annotations / v27FocusSession', () => {
  it('keeps annotations on arXiv documents only', () => {
    const a = (docKey: string) => ({ id: docKey, docKey });
    expect(v27Annotations([a('arxiv:2006.11239'), a('doi:10.1/x'), a('url:example.com/p'), null]).map((x) => x.id)).toEqual([
      'arxiv:2006.11239',
    ]);
  });
  it('drops a Pomodoro-shaped session and keeps a reader session', () => {
    expect(v27FocusSession({ startedAt: 1, phase: 'focus', phaseEndsAt: 9, round: 1 })).toBeNull();
    expect(v27FocusSession(null)).toBeNull();
    const reading = { startedAt: 1, tabIds: [4], title: 'T' };
    expect(v27FocusSession(reading)).toBe(reading);
  });
});

/** Map-backed chrome.storage, enough for migrate(). */
function fakeChrome(seed: Record<string, unknown>) {
  const local = new Map(Object.entries(structuredClone(seed)));
  const keys = (k: string | string[]) => (Array.isArray(k) ? k : [k]);
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (k: string | string[]) =>
          structuredClone(Object.fromEntries(keys(k).filter((x) => local.has(x)).map((x) => [x, local.get(x)]))),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(structuredClone(items))) local.set(k, v);
        },
        remove: async (k: string | string[]) => {
          for (const x of keys(k)) local.delete(x);
        },
      },
      session: { remove: async () => {} },
    },
  });
  return () => structuredClone(Object.fromEntries(local));
}

describe('v27 on a full legacy profile', () => {
  const sentinel = (k: string) => ({ sentinel: k, nested: [1, { deep: k }] });
  const keptSettings = { readerFocusLine: true, claudeKey: 'sk', focusBlocklist: ['x.com'] };
  const deadSettings = {
    displayName: 'A', ollamaUrl: 'u', cloudMode: 'all', mutedTopics: ['x'], trackTopics: ['y'], geminiTopicKey: 'g',
    focusMinutes: 50, breakMinutes: 10, focusSound: true, semanticScholarApiKey: 's', refreshInterval: 30,
    notificationsEnabled: true, theme: 'paperwhite', readerNight: true,
  };
  const arxivPaper = { id: 'p1', deckId: 'd1', title: 'P', url: 'https://arxiv.org/abs/2006.11239', status: 'reading', progressPercent: 20 };
  const webPaper = { id: 'p2', deckId: 'd1', title: 'W', url: 'https://example.com/w.pdf', status: 'to-read', progressPercent: 0 };
  const seed: Record<string, unknown> = {
    ...Object.fromEntries(KEPT_LOCAL_KEYS.map((k) => [k, sentinel(k)])),
    schemaVersion: 26,
    settings: { ...keptSettings, ...deadSettings },
    papers: [arxivPaper, webPaper],
    decks: [{ id: 'd1', name: 'Diffusion' }],
    annotations: [{ id: 'a1', docKey: 'arxiv:2006.11239' }, { id: 'a2', docKey: 'url:example.com/w.pdf' }],
    focusSession: { startedAt: 1, phase: 'focus', phaseEndsAt: 2, round: 1 },
    feeds: ['https://lwn.net/feed'],
    readingProgress: { a: { url: 'https://a.com' } },
    provocations: [{ id: 'q' }],
    aiVectors: { a: 'v' },
  };

  it('drops only the cut, keeps every sentinel and lands on the current schema', async () => {
    const snapshot = fakeChrome(seed);
    await migrate();
    const after = snapshot();
    vi.unstubAllGlobals();
    for (const k of ['feeds', 'readingProgress', 'provocations', 'aiVectors', 'decks']) expect(after).not.toHaveProperty(k);
    expect(after.settings).toEqual(keptSettings);
    expect((after.papers as { id: string }[]).map((p) => p.id)).toEqual(['2006.11239']);
    expect(after.alphaxivPush).toEqual([{ id: '2006.11239', folder: 'Diffusion' }]);
    expect((after.annotations as { id: string }[]).map((a) => a.id)).toEqual(['a1']);
    expect(after.focusSession).toBeNull();
    for (const k of KEPT_LOCAL_KEYS) {
      if (['schemaVersion', 'settings', 'papers', 'alphaxivPush', 'annotations', 'focusSession'].includes(k)) continue;
      expect(after[k]).toEqual(sentinel(k));
    }
    expect(after.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('migrate is idempotent', async () => {
    const snapshot = fakeChrome(seed);
    await migrate();
    const first = snapshot();
    // Force every step to run again rather than pass on the version guard.
    await chrome.storage.local.set({ schemaVersion: 26 });
    await migrate();
    const second = snapshot();
    vi.unstubAllGlobals();
    expect(second).toEqual(first);
  });
});
