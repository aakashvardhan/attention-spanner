import { DEFAULT_FOCUS_BLOCKLIST } from './constants';
import type {
  Annotation,
  AnyProgress,
  BookmarkGroup,
  BookmarkLink,
  Deck,
  FeedItem,
  FocusSession,
  Paper,
  Settings,
} from './types';
import type { TranscriptSegment } from './youtubeCaptions';

export interface LocalSchema {
  schemaVersion: number;
  feeds: string[];
  readItems: string[];
  cachedItems: FeedItem[];
  cacheTimestamp: number;
  settings: Settings;
  readingProgress: Record<string, AnyProgress>;
  focusSession: FocusSession | null;
  bookmarks: BookmarkLink[];
  bookmarkGroups: BookmarkGroup[];
  decks: Deck[];
  /** Research papers, grouped into decks */
  papers: Paper[];
  /** Reader highlights & sticky notes (PDFs and articles), keyed by docKey */
  annotations: Annotation[];
}

export interface SessionSchema {
  trackedTabs: Record<number, { normalizedUrl: string; injectedAt: number }>;
  pendingResume: Record<
    number,
    { scrollY: number; percent: number } | { positionSeconds: number }
  >;
  lastGlobalNudgeAt: number;
  /** Unbroken reading/watching run for the hyperfocus guardrail */
  hyperfocus: { unbrokenSeconds: number; lastDeltaAt: number; notifiedAtSeconds: number };
  /** PDF URLs the user sent to Chrome's native viewer — don't re-intercept this session */
  pdfNativeBypass: string[];
  /**
   * YouTube transcripts for the side panel's Follow pane, keyed by videoId.
   * Session-scoped because a transcript is only interesting while the video is
   * on screen — caching them to disk would grow without a bound anyone watches.
   */
  videoTranscripts: Record<string, TranscriptSegment[]>;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  /* Not 'auto': auto means "match the host browser", which in Chrome is the
     blue skin. The Brave orange is the wanted look regardless of host. */
  skin: 'brave',
  refreshInterval: 30,
  notificationsEnabled: true,
  nudgesEnabled: false,
  hyperfocusEnabled: true,
  focusBlocklist: DEFAULT_FOCUS_BLOCKLIST,
  focusMinutes: 50,
  focusBreakMinutes: 10,
  focusMusicEnabled: false,
  semanticScholarApiKey: '',
};

export const DEFAULTS: LocalSchema = {
  schemaVersion: 22,
  feeds: [],
  readItems: [],
  cachedItems: [],
  cacheTimestamp: 0,
  settings: DEFAULT_SETTINGS,
  readingProgress: {},
  focusSession: null,
  bookmarks: [],
  bookmarkGroups: [],
  decks: [],
  papers: [],
  annotations: [],
};

export const SESSION_DEFAULTS: SessionSchema = {
  trackedTabs: {},
  pendingResume: {},
  lastGlobalNudgeAt: 0,
  hyperfocus: { unbrokenSeconds: 0, lastDeltaAt: 0, notifiedAtSeconds: 0 },
  pdfNativeBypass: [],
  videoTranscripts: {},
};

export async function getLocal<K extends keyof LocalSchema>(
  ...keys: K[]
): Promise<Pick<LocalSchema, K>> {
  const stored = await chrome.storage.local.get(keys);
  const out = {} as Pick<LocalSchema, K>;
  for (const key of keys) {
    out[key] = (stored[key] as LocalSchema[K] | undefined) ?? structuredClone(DEFAULTS[key]);
  }
  return out;
}

export async function setLocal(items: Partial<LocalSchema>): Promise<void> {
  await chrome.storage.local.set(items);
}

export async function getSession<K extends keyof SessionSchema>(
  ...keys: K[]
): Promise<Pick<SessionSchema, K>> {
  const stored = await chrome.storage.session.get(keys);
  const out = {} as Pick<SessionSchema, K>;
  for (const key of keys) {
    out[key] = (stored[key] as SessionSchema[K] | undefined) ?? structuredClone(SESSION_DEFAULTS[key]);
  }
  return out;
}

export async function setSession(items: Partial<SessionSchema>): Promise<void> {
  await chrome.storage.session.set(items);
}

export async function getSettings(): Promise<Settings> {
  const { settings } = await getLocal('settings');
  // Spread over defaults so settings added in later versions pick up their default
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const settings = { ...(await getSettings()), ...patch };
  await setLocal({ settings });
  return settings;
}

/**
 * v0 (legacy vanilla extension) → v1: fold the bare `refreshInterval` key into
 * the settings object. feeds/readItems/cachedItems carry over unchanged.
 * v1 → v2 (Phase 6): backfill counters.videosFinished. Old DayStats entries
 * keep missing videosFinished — read sites use `?? 0` instead of a rewrite.
 * v2 → v3 (Phase 7): backfill counters.focusBlocks (DayStats.focusBlocks
 * likewise stays optional, read with `?? 0`).
 * v3 → v4 (Phase 13): backfill counters.cardsReviewed. The flashcards
 * collections themselves need no migration — getLocal falls back to DEFAULTS.
 * v4 → v5 (papers): decks became typed. Backfill Deck.kind — a deck with
 * cards/notes is 'flashcards', one with only papers is 'papers', empty decks
 * default to 'flashcards' (their historical purpose).
 * v5 → v6 (cloud sync): backfill SyncMeta.updatedAt on records that lack it
 * (tasks, notes, decks, flashCards, bookmarks, bookmarkGroups) from createdAt,
 * so last-write-wins merge has a stable timestamp. FlashNote/Paper already
 * carry updatedAt; deletedAt stays unset (== null) until a real delete.
 * v6 → v7 (one reward currency + one reader): the XP economy, level curve and
 * weekly quest are gone, so drop `gamification.xp` / `lastQuestCelebratedWeek`
 * and the four quest* settings. `counters.chestsOpened` becomes
 * `freezesEarned` (chests now drop streak freezes), `Task.chest.bonusXp`
 * becomes a bare `rolled` marker, and the merged 'progress' card leaves
 * dashCardOrder. The reader also gained a second document kind, so
 * `pdfAnnotations` becomes `annotations` with its page/rect fields wrapped in
 * a discriminated `anchor` (see types.AnnotationAnchor).
 * v7 → v8 (prime time): seed `DayStats.hours` from the timestamps already kept
 * on tasks, notes, bookmarks, annotations, flash notes, papers and reading
 * progress, so the punchcard opens with real history. `hours` itself stays
 * optional — days with neither evidence nor live credit simply lack it.
 * v8 → v9 (encrypted notes): the passcode became a real key rather than a
 * render gate, so `settings.notesPasscodeHash` goes away — the vault in
 * `notesVault` authenticates by unwrapping, and nothing derived from the
 * passcode is stored. Existing notes stay plain text until the user turns
 * encryption on in Options, which seals them in place.
 * v9 → v10 (bring-your-own calendar client): Google Calendar stopped using
 * chrome.identity.getAuthToken, so the old connection is a token Chrome holds
 * and this extension can no longer ask for. Reset the slice — the user pastes
 * their own OAuth client in Settings and reconnects.
 * v11 → v12 (reader progress): repair reading entries that took the reader
 * page's own title and URL, which left Continue rows called "Reader" linking to
 * the extension instead of the article. See v12ReadingProgress.
 * v12 → v13 (Notion removed): the one-way push and the meeting-notes pull are
 * gone, so drop the notion* settings (one of which held an integration token),
 * the push queue/status, and the meeting-notes cache.
 * v13 → v14 (knowledge graph): seed `graphNodes` from the reading history that
 * still exists. Only articles and videos — papers, bookmarks and recordings
 * are reconciled on the first graph open, which also covers a device that
 * pulls them via sync after this migration has already run.
 * v14 → v15 (Brave accent by default): the default skin moved from 'auto' to
 * 'brave', but patchSettings persists the whole settings object, so anyone who
 * ever changed any setting has a stored 'auto' shadowing the new default.
 * Rewrite that one value. An explicit 'chrome'/'default' is a real choice and
 * is left alone — only 'auto' means "never picked".
 * v15 → v16 (dashboard presets): replace arbitrary columns/order/hide/width
 * settings with one predictable, accessible layout mode. Existing users begin
 * in Focused; their content is untouched.
 * v17 → v18 (Attention Relay): add the device-local active intention and
 * parking lot. Research data and connected Google services opt existing users
 * into their matching secondary packs; no retired data is deleted.
 * v18 → v19: add the device-local cache populated from the user's X bookmarks
 * page. It deliberately stays outside cloud-sync collections.
 * v20 → v21 (daily gate removed): the morning brain-dump gate is gone, so its
 * device-local completion state goes with it. Notes themselves are untouched —
 * the capture card and its AI structuring stay; only the interstitial that
 * stood between the user and the dashboard is removed. The v17 branch that
 * seeded this key is deleted rather than stubbed: it only ever wrote the key
 * this migration removes.
 */
export async function migrate(): Promise<void> {
  const { schemaVersion } = await chrome.storage.local.get('schemaVersion');
  const version = (schemaVersion as number | undefined) ?? 0;
  // Must match the version written at the end: this guard was left at 10 when
  // v11 landed, which stranded anyone already on 10 — they never ran v11.
  if (version >= 22) return;

  // Only branches that repair data a SURVIVING feature reads are kept. Every
  // migration that merely seeded a key now removed — the calendar defaults, the
  // feature packs, the dashboard presets, the gamification counters — is gone
  // rather than stubbed, because v22's sweep below lands a profile in exactly
  // the same state. This is the pattern v21 already used for v17's gate key.
  if (version < 5) await migrateToV5();
  if (version < 6) await migrateToV6();
  if (version < 7) await migrateToV7();
  // v10 → v11: feed item ids were truncated to 24 bytes of input, so every
  // article on a site shared one — the stored read state marked whole sites
  // read. The ids are unmappable to the new scheme, and the old values are
  // worse than none, so start over. Everything shows unread once.
  if (version < 11) await chrome.storage.local.set({ readItems: [] });
  if (version < 12) await migrateToV12();
  if (version < 15) await migrateToV15();
  await migrateToV22();

  await chrome.storage.local.set({ schemaVersion: 22 });
}

/**
 * Every key belonging to a feature that has been cut. Removing them is not
 * cosmetic: `getLocal` merges DEFAULTS over what is stored, so an orphaned key
 * sits in quota forever, and `recordings`-sized values are not small. Settings
 * need an explicit delete too — patchSettings writes the whole merged object,
 * so a dropped field stays on disk for anyone who ever opened Settings, and
 * changing DEFAULT_SETTINGS alone never reaches them.
 *
 * This list is cumulative: it carries every key retired by v13, v20 and v21 as
 * well, so a profile jumping straight from an old version lands clean without
 * those migrations having to run.
 */
export const V22_DEAD_KEYS = [
  // Notes, brain dump, and the encrypted vault (v13's Notion keys ride along)
  'notes',
  'notesVault',
  'notionQueue',
  'notionStatus',
  'meetingNotes',
  'dailyBrainDumpGate',
  // Tasks and quick capture
  'tasks',
  // Job board
  'jobs',
  'jobSources',
  'jobProfile',
  'jobRuns',
  // Assistant, journal, automations, weekly review
  'assistantMemory',
  'assistantSkills',
  'assistantAutomations',
  'assistantJournal',
  'assistantProfile',
  'assistantBriefing',
  'weekReviews',
  'pdfOutlineCache',
  // Recordings and live transcription
  'recordings',
  // Google
  'calendar',
  'gmail',
  // Streaks, gamification, prime time
  'streaks',
  'gamification',
  'gym',
  'warmup',
  // Time pill
  'siteTime',
  // Attention relay and feature packs
  'activeIntent',
  'enabledPacks',
  'parkingLot',
  // Citation graph and its reverse index
  'docCitations',
  'graphCitations',
  'graphNodes',
  'graphView',
  'graphVisible',
  // Cut before this pass, swept here so one list is the whole truth
  'sync',
  'tombstones',
  'flashCards',
  'flashNotes',
  'srsDaily',
  'alphaxiv',
  'xBookmarks',
  'xBookmarksLastSyncedAt',
];

export const V22_DEAD_SETTINGS = [
  // Assistant and its providers
  'assistantEnabled',
  'geminiApiKey',
  'anthropicApiKey',
  'cloudProvider',
  'assistantReactEnabled',
  'assistantVoiceEnabled',
  'assistantTtsVoice',
  'assistantVisionEnabled',
  'assistantLiveEnabled',
  'assistantMonitorEnabled',
  'assistantWakeWordEnabled',
  'monitorEveningTime',
  'ollamaBaseUrl',
  'ollamaModel',
  // Tasks, sprints, streak goal
  'taskReminderIntervalMinutes',
  'sprintMinutes',
  'dailyGoalMinutes',
  // Google
  'gmailTriageTime',
  'focusCalendarBlockEnabled',
  // Time pill
  'timePillHosts',
  // Retired earlier; listed so one sweep is the whole truth
  'dashboardMode',
  'dashColumns',
  'dashCardOrder',
  'dashHiddenCards',
  'dashFullWidthCards',
  'gymWeeklyTarget',
  'gymReminderTime',
  'notesPasscodeHash',
  'questArticlesPerWeek',
  'questSprintsPerWeek',
  'questVideosPerWeek',
  'questFocusPerWeek',
];

/** Pure core of v22's settings half, so the delete rule is testable. */
export function v22StripSettings(
  settings: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!settings || typeof settings !== 'object') return null;
  const next = { ...settings };
  for (const key of V22_DEAD_SETTINGS) delete next[key];
  return next;
}

async function migrateToV22(): Promise<void> {
  await chrome.storage.local.remove(V22_DEAD_KEYS);
  // Read fresh rather than from a snapshot taken at the top of migrate(): the
  // earlier branches write settings themselves.
  const { settings } = await chrome.storage.local.get('settings');
  const next = v22StripSettings(settings as Record<string, unknown> | undefined);
  if (next) await chrome.storage.local.set({ settings: next });
}

/** v4 → v5: decks predate `kind`; papers live in them, so default to papers. */
async function migrateToV5(): Promise<void> {
  const { decks, papers } = await chrome.storage.local.get(['decks', 'papers']);
  const deckList = (decks as Deck[] | undefined) ?? [];
  if (!deckList.length) return;
  const paperList = (papers as { deckId: string }[] | undefined) ?? [];
  for (const deck of deckList) {
    if (deck.kind) continue;
    deck.kind = paperList.some((p) => p.deckId === deck.id) ? 'papers' : 'flashcards';
  }
  await chrome.storage.local.set({ decks: deckList });
}

/** v5 → v6: backfill `updatedAt` from `createdAt` on the collections that survive. */
async function migrateToV6(): Promise<void> {
  const keys = ['decks', 'bookmarks', 'bookmarkGroups'] as const;
  const collections = await chrome.storage.local.get([...keys]);
  const patch: Record<string, unknown> = {};
  for (const key of keys) {
    const list = collections[key] as { createdAt?: number; updatedAt?: number }[] | undefined;
    if (!list?.length) continue;
    patch[key] = list.map((r) => (r.updatedAt == null ? { ...r, updatedAt: r.createdAt ?? 0 } : r));
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

/**
 * Pure core of v6 → v7's surviving half. Annotations grew an anchor union when
 * the reader learned to read articles; every record from before then is a PDF
 * one. Returns null when there is nothing to convert.
 */
export function v7Annotations(
  legacy: unknown,
): Record<string, unknown>[] | null {
  const list = legacy as
    | ({ page: number; rects: unknown[]; x: number; y: number; pdfUrl: string } & Record<
        string,
        unknown
      >)[]
    | undefined;
  if (!list?.length) return null;
  return list.map(({ page, rects, x, y, pdfUrl, ...rest }) => ({
    ...rest,
    docUrl: pdfUrl,
    anchor: { kind: 'pdf' as const, page, rects, x, y },
  }));
}

async function migrateToV7(): Promise<void> {
  const { pdfAnnotations } = await chrome.storage.local.get('pdfAnnotations');
  const converted = v7Annotations(pdfAnnotations);
  if (converted) await chrome.storage.local.set({ annotations: converted });
  if (pdfAnnotations !== undefined) await chrome.storage.local.remove('pdfAnnotations');
}

export function v15Skin(settings: Partial<Settings> | undefined): Partial<Settings> | null {
  if (settings?.skin !== 'auto') return null;
  return { ...settings, skin: DEFAULT_SETTINGS.skin };
}

async function migrateToV15(): Promise<void> {
  const { settings } = await chrome.storage.local.get('settings');
  const patched = v15Skin(settings as Partial<Settings> | undefined);
  if (patched) await chrome.storage.local.set({ settings: patched });
}

/** The document a reader-page URL was showing, or null if this isn't one. */
function readerDocUrl(url: string): string | null {
  if (!url.startsWith('chrome-extension://')) return null;
  try {
    const params = new URL(url).searchParams;
    return params.get('article') ?? params.get('src');
  } catch {
    return null;
  }
}

/**
 * Pure core of v11 → v12. Progress reported from the reader used to be stamped
 * with the reader tab's own title and URL, so a Continue row could read
 * "Reader" and open the extension page instead of the article. The real URL
 * survives inside the reader link's ?article=/?src= param; the title doesn't,
 * so it's cleared and refills the next time the article is opened. Returns null
 * when nothing was corrupted, so an untouched profile isn't rewritten.
 */
export function v12ReadingProgress(
  progress: Record<string, AnyProgress>,
): Record<string, AnyProgress> | null {
  const repaired: Record<string, AnyProgress> = {};
  let changed = false;
  for (const [key, entry] of Object.entries(progress)) {
    const docUrl = entry.kind === 'video' ? null : readerDocUrl(entry.url);
    if (!docUrl) {
      repaired[key] = entry;
      continue;
    }
    repaired[key] = { ...entry, url: docUrl, title: entry.title === 'Reader' ? '' : entry.title };
    changed = true;
  }
  return changed ? repaired : null;
}

async function migrateToV12(): Promise<void> {
  const { readingProgress } = await chrome.storage.local.get('readingProgress');
  if (!readingProgress) return;
  const repaired = v12ReadingProgress(readingProgress as Record<string, AnyProgress>);
  if (repaired) await chrome.storage.local.set({ readingProgress: repaired });
}
