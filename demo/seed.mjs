/**
 * Demo-data seeder for the recorded product demo (demo/record.mjs).
 *
 * Produces a LocalSchema payload (src/shared/storage.ts, v22) that makes the
 * new tab look like real use: a few things left unfinished, a paper mid-read,
 * and a populated speed dial.
 *
 * Keep this in step with LocalSchema. A key that no longer exists is not
 * harmless — migrate() sweeps it on the next install, so seeding one is a
 * silent no-op that makes the demo look broken for reasons nobody can see.
 *
 * Deterministic (fixed offsets from `now`) so re-recordings look identical.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export function buildSeed(now = Date.now()) {
  const h = (n) => now - n * HOUR;
  const day = (n) => now - n * DAY;

  const settings = {
    theme: 'dark',
    skin: 'brave',
    refreshInterval: 30,
    notificationsEnabled: true,
    nudgesEnabled: true,
    hyperfocusEnabled: true,
    focusBlocklist: ['mail.google.com', 'linkedin.com', 'netflix.com'],
    focusMinutes: 50,
    focusBreakMinutes: 10,
    focusMusicEnabled: false,
    semanticScholarApiKey: '',
  };

  /* ---- Continue reading: one article part-read, one video part-watched ---- */
  const readingProgress = {
    'https://www.additudemag.com/adhd-dopamine-design': {
      kind: 'article',
      url: 'https://www.additudemag.com/adhd-dopamine-design',
      title: 'Why ADHD Brains Crave Dopamine — and How to Design Around It',
      source: 'ADDitude',
      feedItemId: null,
      maxPercent: 62,
      scrollY: 3410,
      pageHeight: 8800,
      activeSeconds: 9 * 60,
      firstOpenedAt: day(1),
      updatedAt: h(5),
      completedAt: null,
      nudge: { count: 1, lastAt: h(4), dismissed: false },
    },
    'youtube.com/watch?v=demo-focus-toolkit': {
      kind: 'video',
      url: 'https://www.youtube.com/watch?v=demo-focus-toolkit',
      title: 'Focus Toolkit: Science-Based Tools to Improve Concentration',
      source: 'Huberman Lab',
      videoId: 'demo-focus-toolkit',
      durationSeconds: 5460,
      positionSeconds: 2214,
      maxPercent: 41,
      activeSeconds: 2214,
      firstOpenedAt: day(2),
      updatedAt: h(26),
      completedAt: null,
      nudge: { count: 0, lastAt: 0, dismissed: false },
    },
  };

  /* ---- Papers, in the deck they live in ---- */
  const decks = [
    { id: 'demo-deck-papers', name: 'Reading list', kind: 'papers', createdAt: day(60), updatedAt: day(60) },
  ];
  const papers = [
    {
      id: 'demo-paper-1',
      deckId: 'demo-deck-papers',
      title: 'Attention Is All You Need',
      authors: 'Vaswani, Shazeer, Parmar, et al.',
      venue: 'NeurIPS',
      year: 2017,
      citations: 131000,
      url: 'https://arxiv.org/abs/1706.03762',
      abstract: 'Introduces the Transformer, dispensing with recurrence entirely in favor of attention.',
      relevance: 'The other kind of attention I manage.',
      status: 'reading',
      progressPercent: 55,
      leftOff: 'Section 3.2 — multi-head attention',
      addedAt: day(12),
      updatedAt: h(30),
      lastReadAt: h(30),
    },
    {
      id: 'demo-paper-2',
      deckId: 'demo-deck-papers',
      title: 'The Cost of Interrupted Work: More Speed and Stress',
      authors: 'Mark, Gudith, Klocke',
      venue: 'CHI',
      year: 2008,
      citations: 2100,
      url: 'https://dl.acm.org/doi/10.1145/1357054.1357072',
      abstract: '',
      relevance: 'Why the tab-switch nudge exists.',
      status: 'to-read',
      progressPercent: 0,
      leftOff: '',
      addedAt: day(6),
      updatedAt: day(6),
      lastReadAt: null,
    },
  ];

  /* ---- Speed dial ---- */
  const bookmarkGroups = [
    { id: 'demo-grp-daily', name: 'Daily', createdAt: day(200), updatedAt: day(200) },
    { id: 'demo-grp-learn', name: 'Learning', createdAt: day(180), updatedAt: day(180) },
  ];
  const bm = (id, url, title, groupId, agoDays) => ({
    id: `demo-bm-${id}`,
    url,
    title,
    groupId,
    createdAt: day(agoDays),
    updatedAt: day(agoDays),
  });
  const bookmarks = [
    bm(1, 'https://github.com', 'GitHub', 'demo-grp-daily', 200),
    bm(2, 'https://www.notion.so', 'Notion', 'demo-grp-daily', 200),
    bm(3, 'https://calendar.google.com', 'Calendar', 'demo-grp-daily', 199),
    bm(4, 'https://news.ycombinator.com', 'Hacker News', 'demo-grp-daily', 150),
    bm(5, 'https://arxiv.org', 'arXiv', 'demo-grp-learn', 120),
    bm(6, 'https://developer.chrome.com', 'Chrome Docs', 'demo-grp-learn', 90),
  ];

  return {
    schemaVersion: 22,
    feeds: ['https://hnrss.org/frontpage', 'https://www.theverge.com/rss/index.xml'],
    readItems: [],
    cachedItems: [],
    cacheTimestamp: 0,
    settings,
    readingProgress,
    focusSession: null,
    bookmarks,
    bookmarkGroups,
    decks,
    papers,
    annotations: [],
  };
}
