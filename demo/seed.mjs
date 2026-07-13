/**
 * Demo-data seeder for the recorded product demo (demo/record.mjs).
 *
 * Produces a full LocalSchema payload (src/shared/storage.ts) that makes the
 * dashboard look like ~10 months of real use, tuned so the on-camera gym
 * check-in does three visible things at once:
 *   - 3rd check-in of the week (target 3) → week qualifies → streak 7 → 8
 *   - completes the weekly quest (other lines pre-met) → +50 XP banner
 *   - 50th lifetime workout → unlocks the 🦾 "Iron Habit" badge tile
 *
 * Deterministic (seeded PRNG) so re-recordings look identical.
 */

// mulberry32 — tiny deterministic PRNG
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function daysAgo(n, from) {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  d.setHours(12, 0, 0, 0);
  return d;
}

/** Monday of the week containing `date` (matches src/shared/week.ts) */
function weekKey(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDate(d);
}

// Mirrors DEFAULT_SETTINGS in src/shared/storage.ts — seeded in full so code
// paths that read stored settings without spreading defaults still work.
const SETTINGS = {
  theme: 'dark',
  refreshInterval: 30,
  notificationsEnabled: true,
  nudgesEnabled: true,
  nudgeDelayMinutes: 3,
  nudgeCooldownMinutes: 60,
  nudgeMaxPerArticle: 2,
  taskReminderIntervalMinutes: 120,
  sprintMinutes: 5,
  dailyGoalMinutes: 5,
  gymWeeklyTarget: 3,
  gymReminderTime: '18:00',
  questArticlesPerWeek: 2,
  questSprintsPerWeek: 5,
  questVideosPerWeek: 1,
  videoMinMinutes: 15,
  hyperfocusMinutes: 90,
  timePillHosts: [],
  focusBlocklist: [
    'twitter.com', 'x.com', 'reddit.com', 'instagram.com', 'facebook.com',
    'tiktok.com', 'youtube.com', 'news.ycombinator.com',
  ],
  focusMinutes: 50,
  focusBreakMinutes: 10,
  questFocusPerWeek: 5,
  focusMusicEnabled: false,
  dashColumns: 3,
  dashCardOrder: ['links', 'tasks', 'continue', 'streak', 'gym', 'progress', 'braindump', 'flashcards', 'papers'],
  dashHiddenCards: [],
  dashFullWidthCards: [],
  semanticScholarApiKey: '',
};

export function buildSeed(now = Date.now()) {
  const rand = rng(20260710);
  const nowDate = new Date(now);
  const today = localDate(nowDate);
  const thisWeek = weekKey(nowDate);
  const prevWeek = weekKey(daysAgo(7, nowDate));

  /* ---- streaks.daily: ~320 days of activity with a lived-in rhythm ---- */
  const daily = {};
  const gymCheckins = {};
  for (let i = 320; i >= 0; i--) {
    const d = daysAgo(i, nowDate);
    const date = localDate(d);
    const dow = d.getDay(); // 0=Sun
    // Ramp: sparse early, denser in the recent 4 months; quieter weekends
    const density = i > 200 ? 0.45 : i > 120 ? 0.6 : 0.8;
    const weekendPenalty = dow === 0 || dow === 6 ? 0.6 : 1;
    const active = rand() < density * weekendPenalty;
    // Gym ~2-3x/week (Mon/Wed/Fri-ish), independent of reading activity
    if ((dow === 1 || dow === 3 || dow === 5) && rand() < 0.72 && i > 0) {
      gymCheckins[date] = d.getTime();
    }
    if (!active && i > 12) continue; // keep the last 12 days unbroken (streak)
    const heavy = rand() < 0.3;
    daily[date] = {
      minutes: Math.round(6 + rand() * (heavy ? 55 : 24)),
      sprints: rand() < 0.5 ? Math.ceil(rand() * 2) : 0,
      articlesFinished: rand() < 0.45 ? Math.ceil(rand() * 2) : 0,
      videosFinished: rand() < 0.2 ? 1 : 0,
      focusBlocks: rand() < 0.4 ? Math.ceil(rand() * 2) : 0,
      tasksCompleted: rand() < 0.6 ? Math.ceil(rand() * 3) : 0,
    };
  }

  /* ---- This week: every quest line pre-met except gym (2/3) ----
     Mon..today already contain organic data; overwrite Mon-Thu to hit
     articles>=2, sprints>=5, videos>=1, focus>=5 exactly on camera-day. */
  const mondayThisWeek = new Date(...thisWeek.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const weekDay = (offset) => localDate(new Date(mondayThisWeek.getFullYear(), mondayThisWeek.getMonth(), mondayThisWeek.getDate() + offset));
  const thisWeekStats = [
    { minutes: 34, sprints: 2, articlesFinished: 1, videosFinished: 0, focusBlocks: 2, tasksCompleted: 2 }, // Mon
    { minutes: 21, sprints: 1, articlesFinished: 0, videosFinished: 1, focusBlocks: 1, tasksCompleted: 1 }, // Tue
    { minutes: 42, sprints: 1, articlesFinished: 1, videosFinished: 0, focusBlocks: 1, tasksCompleted: 3 }, // Wed
    { minutes: 18, sprints: 1, articlesFinished: 0, videosFinished: 0, focusBlocks: 1, tasksCompleted: 1 }, // Thu
  ];
  thisWeekStats.forEach((stats, i) => {
    const date = weekDay(i);
    if (date <= today) daily[date] = stats;
  });
  // Today so far: qualified (streak-safe) but modest
  daily[today] = { minutes: 12, sprints: 0, articlesFinished: 0, videosFinished: 0, focusBlocks: 0, tasksCompleted: 1 };

  // Gym this week: Mon + Wed done; the on-camera check-in is #3 of target 3
  delete gymCheckins[weekDay(4)];
  delete gymCheckins[weekDay(5)];
  delete gymCheckins[weekDay(6)];
  delete gymCheckins[today];
  gymCheckins[weekDay(0)] = now - 4 * 86400e3;
  gymCheckins[weekDay(2)] = now - 2 * 86400e3;

  const h = (n) => now - n * 3600e3; // n hours ago
  const day = (n) => now - n * 86400e3; // n days ago

  /* ---- Tasks ---- */
  const task = (id, text, createdAgoH, completedAgoH = null, source = 'newtab') => ({
    id: `demo-task-${id}`,
    text,
    createdAt: h(createdAgoH),
    completedAt: completedAgoH === null ? null : h(completedAgoH),
    snoozedUntil: null,
    source,
    updatedAt: h(completedAgoH ?? createdAgoH),
  });
  const tasks = [
    task(1, 'Review the sync-conflict PR before standup', 20),
    task(2, 'Email Prof. Lin the extension study results', 30, null, 'capture'),
    task(3, 'Renew gym membership before Friday', 52),
    task(4, 'Outline the LinkedIn launch post 🚀', 8, null, 'braindump'),
    task(5, 'Fix the flashcard cloze parser edge case', 70, 26),
    task(6, 'Ship the v1.0 build to the store', 96, 44),
  ];

  /* ---- Brain-dump history ---- */
  const notes = [
    {
      id: 'demo-note-1',
      rawText: 'launch post needs screenshots, ask darsh to proofread, gym friday, that flaky sync test again',
      status: 'structured',
      bullets: [
        'Launch post still needs screenshots',
        'Ask Darsh to proofread the draft',
        'Gym session planned for Friday',
        'Flaky sync test keeps recurring',
      ],
      proposedTasks: [
        { text: 'Add screenshots to the launch post', addedTaskId: null },
        { text: 'Send draft to Darsh for proofreading', addedTaskId: null },
      ],
      createdAt: day(1),
      structuredAt: day(1) + 60e3,
      updatedAt: day(1) + 60e3,
    },
    {
      id: 'demo-note-2',
      rawText: 'ideas: weekly review card, flashcard export is done, maybe a mobile widget someday',
      status: 'structured',
      bullets: ['Idea: weekly review card', 'Flashcard export shipped', 'Long-term: mobile widget'],
      proposedTasks: [{ text: 'Sketch the weekly review card', addedTaskId: null }],
      createdAt: day(3),
      structuredAt: day(3) + 45e3,
      updatedAt: day(3) + 45e3,
    },
  ];

  /* ---- Continue-reading entries ---- */
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

  /* ---- Flashcards: one deck, 5 cards due now ---- */
  const fcQA = [
    ['What does the SM-2 ease factor control?', 'How fast review intervals grow — floor 1.3, default 2.5.'],
    ['Why do MV3 service workers complicate timers?', 'They are killed when idle, so alarms must replace setTimeout.'],
    ['What is declarativeNetRequest used for here?', 'Browser-level site blocking during focus sessions.'],
    ['What makes a spaced-repetition card "due"?', 'Its dueAt timestamp has passed for its current phase.'],
    ['Where does Gemini Nano run?', 'Entirely on-device via Chrome\'s Prompt API — nothing leaves the machine.'],
  ];
  const decks = [
    { id: 'demo-deck-sys', name: 'Extension Engineering', createdAt: day(60), kind: 'flashcards', updatedAt: day(60) },
    { id: 'demo-deck-papers', name: 'Attention Research', createdAt: day(45), kind: 'papers', updatedAt: day(45) },
  ];
  const flashNotes = fcQA.map(([front, back], i) => ({
    id: `demo-fnote-${i}`,
    deckId: 'demo-deck-sys',
    type: 'basic',
    front,
    back,
    reversed: false,
    createdAt: day(40 - i * 3),
    updatedAt: day(40 - i * 3),
  }));
  const flashCards = flashNotes.map((n, i) => ({
    id: `${n.id}#0`,
    noteId: n.id,
    deckId: 'demo-deck-sys',
    variant: 0,
    phase: 'review',
    stepIndex: 0,
    ease: 2.4 + (i % 3) * 0.1,
    intervalDays: 4 + i * 3,
    dueAt: h(3 + i),
    lapses: i === 2 ? 1 : 0,
    reps: 5 + i * 2,
    createdAt: n.createdAt,
    updatedAt: n.createdAt,
  }));

  /* ---- srsDaily: recent review history (activity calendar richness) ---- */
  const srsDaily = {};
  for (let i = 1; i <= 10; i++) {
    if (rand() < 0.35) continue;
    const date = localDate(daysAgo(i, nowDate));
    const n = 6 + Math.floor(rand() * 16);
    srsDaily[date] = { reviews: { 'demo-deck-sys': n }, newIntroduced: { 'demo-deck-sys': i % 3 } };
  }

  /* ---- Papers ---- */
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

  /* ---- Links card ---- */
  const bookmarkGroups = [
    { id: 'demo-grp-daily', name: 'Daily', createdAt: day(200), updatedAt: day(200) },
    { id: 'demo-grp-learn', name: 'Learning', createdAt: day(180), updatedAt: day(180) },
  ];
  const bm = (id, url, title, groupId, agoDays) => ({
    id: `demo-bm-${id}`, url, title, groupId, createdAt: day(agoDays), updatedAt: day(agoDays),
  });
  const bookmarks = [
    bm(1, 'https://github.com', 'GitHub', 'demo-grp-daily', 200),
    bm(2, 'https://mail.google.com', 'Gmail', 'demo-grp-daily', 200),
    bm(3, 'https://calendar.google.com', 'Calendar', 'demo-grp-daily', 199),
    bm(4, 'https://news.ycombinator.com', 'Hacker News', 'demo-grp-daily', 150),
    bm(5, 'https://arxiv.org', 'arXiv', 'demo-grp-learn', 120),
    bm(6, 'https://developer.chrome.com', 'Chrome Docs', 'demo-grp-learn', 90),
  ];

  /* ---- Gamification: one click away from quest + badge + streak-8 ----
     XP 2440 = level 7 (2100 floor, 700 span) at 340/700; check-in adds
     20 (gym) + 50 (quest) → 410/700, a visible bar jump.
     workouts 49 → 50 on camera unlocks gym-50 "Iron Habit". */
  const badgeIds = [
    'first-workout', 'gym-10', 'gym-streak-4', 'first-article', 'articles-10',
    'first-video', 'videos-10', 'read-streak-7', 'sprints-25', 'first-focus',
    'focus-25', 'tasks-50', 'cards-100', 'dumps-10', 'level-5',
  ];
  const badges = {};
  badgeIds.forEach((id, i) => { badges[id] = day(300 - i * 18); });

  return {
    schemaVersion: 6,
    feeds: [],
    readItems: [],
    cachedItems: [],
    cacheTimestamp: 0,
    settings: SETTINGS,
    tasks,
    notes,
    readingProgress,
    streaks: {
      currentStreak: 12,
      longestStreak: 23,
      lastQualifiedDate: today,
      daily,
      freezeTokens: 2,
    },
    gym: {
      checkins: gymCheckins,
      currentWeekStreak: 7,
      longestWeekStreak: 9,
      lastQualifiedWeek: prevWeek,
    },
    gamification: {
      xp: 2440,
      badges,
      lastQuestCelebratedWeek: prevWeek,
      counters: {
        workouts: 49,
        articlesFinished: 37,
        videosFinished: 12,
        sprints: 61,
        tasksCompleted: 68,
        brainDumps: 14,
        focusBlocks: 41,
        cardsReviewed: 132,
        chestsOpened: 6,
      },
    },
    focusSession: null,
    bookmarks,
    bookmarkGroups,
    decks,
    flashNotes,
    flashCards,
    papers,
    srsDaily,
    siteTime: { date: '', hosts: {} },
  };
}
