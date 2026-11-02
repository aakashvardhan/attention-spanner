import type { AlphaxivAuth, AlphaxivStatus } from './alphaxiv';
import { DEFAULT_FOCUS_BLOCKLIST } from './constants';
import { arxivId } from './papers';
import type {
  AiCacheEntry,
  Annotation,
  DayActivity,
  Dump,
  FocusSession,
  Folder,
  LockedDump,
  Paper,
  Settings,
  Vault,
} from './types';

export interface LocalSchema {
  schemaVersion: number;
  settings: Settings;
  focusSession: FocusSession | null;
  /** alphaXiv folders, mirrored; each is a shelf */
  folders: Folder[];
  /** Papers on the shelf, keyed by arXiv id (alphaXiv mirror + local reading state) */
  papers: Paper[];
  /** v27 papers to save once into alphaXiv, into a folder named after their old deck */
  alphaxivPush: { id: string; folder: string }[];
  /** alphaXiv sign-in (background/alphaxiv.ts is the only reader and writer); null = signed out */
  alphaxivAuth: AlphaxivAuth | null;
  /** The OAuth client registered for this extension's redirect URI */
  alphaxivClient: { clientId: string; redirectUri: string } | null;
  /** Who is signed in, the last sync, and the last error, for Settings */
  alphaxivStatus: AlphaxivStatus;
  /** Reader highlights & sticky notes, keyed by docKey */
  annotations: Annotation[];
  /** Generated text keyed 'task:hash' (llm/store.ts); a cache, so loss is harmless */
  aiCache: Record<string, AiCacheEntry>;
  /** Per local day 'YYYY-MM-DD': papers read, reading minutes (shared/activity.ts) */
  activity: Record<string, DayActivity>;
  /**
   * Brain dumps waiting for first-time vault setup, in the clear until then.
   * Never rename this to a key in V22_DEAD_KEYS ('notes', 'parkingLot'...):
   * that sweep re-runs on every schema bump and would delete them.
   */
  dumps: Dump[];
  /** The dump vault; null until the first dump's setup */
  vault: Vault | null;
  /** Sealed dumps, newest first (shared/vault.ts) */
  lockedDumps: LockedDump[];
}

export interface SessionSchema {
  /** PDF URLs the user sent to Chrome's native viewer — don't re-intercept this session */
  pdfNativeBypass: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  readerFocusLine: false,
  focusBlocklist: DEFAULT_FOCUS_BLOCKLIST,
  claudeKey: '',
};

export const SCHEMA_VERSION = 28;

export const DEFAULTS: LocalSchema = {
  schemaVersion: SCHEMA_VERSION,
  settings: DEFAULT_SETTINGS,
  focusSession: null,
  folders: [],
  papers: [],
  alphaxivPush: [],
  alphaxivAuth: null,
  alphaxivClient: null,
  alphaxivStatus: { email: '', lastSyncAt: null, error: '' },
  annotations: [],
  // Additive, so no migration: getLocal and useStorageValue fall back to
  // DEFAULTS for a key that was never written.
  aiCache: {},
  activity: {},
  dumps: [],
  vault: null,
  lockedDumps: [],
};

export const SESSION_DEFAULTS: SessionSchema = {
  pdfNativeBypass: [],
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

/**
 * Dump writes read a list, seal, then write it back. Two tabs doing that at
 * once would drop one entry, so they take turns through a Web Lock, which
 * every page of the extension shares.
 */
export function withDumpLock<T>(fn: () => Promise<T>): Promise<T> {
  return navigator.locks.request('dumps', fn);
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
 * Schema history, as it still exists in code.
 *
 * Most of the chain has been collapsed. A migration whose only job was to seed
 * a key that a later version removes is deleted rather than stubbed — v22's
 * sweep lands such a profile in exactly the same state, and a branch that
 * writes a key nothing reads is just a slower way to arrive there. What
 * survives below is only the migrations that repair data a LIVE feature reads.
 *
 * v6 → v7 (one reader): the reader gained a second document kind, so
 * `pdfAnnotations` becomes `annotations` with its page/rect fields wrapped in
 * a discriminated `anchor` (see types.AnnotationAnchor).
 * v14 → v15 rewrote a stored skin 'auto' to 'brave'. Skins were retired in the
 * Edition redesign (2026-10), so the step is gone; the version number stays.
 * v21 → v22 (complement Notion, don't duplicate it): notes, tasks, meeting
 * notes, job tracking, the assistant, Google, and the habit layer are all
 * gone. Their keys and settings are swept in one cumulative pass that also
 * carries what v13, v20 and v21 retired — see V22_DEAD_KEYS.
 * v22 → v23: the daily focus line and the unreachable Pomodoro mode went.
 * Their key and setting join the same cumulative lists, and the sweep re-runs
 * — removing an absent key is a no-op, so re-running v22's entries is free.
 * v23 → v24: brain dumps lose their task fields and sorted points (v24Dumps).
 * v24 → v25 (minimal revamp) and v25 → v26 repaired reading-progress records;
 * that key is gone in v27, so their steps are too.
 * v26 → v27 (papers library): RSS, video, topic gate, web tracking, local AI,
 * decks and provocations went into the cumulative lists. Papers are re-keyed
 * by arXiv id and queued for alphaXiv (v27Papers); non-arXiv papers and
 * annotations go (v27Annotations); a Pomodoro session is dropped (v27FocusSession).
 * v27 → v28 (walnut and brass): the theme choice and reader night mode are
 * gone; the cumulative sweep re-runs to drop both settings.
 */
export async function migrate(): Promise<void> {
  const { schemaVersion } = await chrome.storage.local.get('schemaVersion');
  const version = (schemaVersion as number | undefined) ?? 0;
  // Session storage outlives an extension update, so retired keys go on every
  // install/update, before the early return. Removing an absent key is a no-op.
  await chrome.storage.session.remove(['hyperfocus', 'driftChecked', 'lastGlobalNudgeAt']);
  // Must match the version written at the end: this guard was left at 10 when
  // v11 landed, which stranded anyone already on 10 — they never ran v11.
  if (version >= SCHEMA_VERSION) return;

  // Only branches that repair data a SURVIVING feature reads are kept. Every
  // migration that merely seeded a key now removed — the calendar defaults, the
  // feature packs, the dashboard presets, the gamification counters — is gone
  // rather than stubbed, because v22's sweep below lands a profile in exactly
  // the same state. This is the pattern v21 already used for v17's gate key.
  if (version < 7) await migrateToV7();
  // v27 reads the old decks, so it runs before the cumulative sweep removes them.
  if (version < 27) await migrateToV27();
  await migrateToV22();
  if (version < 24) {
    const { dumps } = await chrome.storage.local.get('dumps');
    await chrome.storage.local.set({ dumps: v24Dumps((dumps as unknown[] | undefined) ?? []) });
  }

  await chrome.storage.local.set({ schemaVersion: SCHEMA_VERSION });
}

/** v27: papers only. Session keys of the cut features. */
export const V27_DEAD_SESSION_KEYS = ['trackedTabs', 'pendingResume', 'videoTranscripts', 'topicVerdicts'];

/**
 * v26 → v27 (papers library): only arXiv papers survive, keyed by arXiv id, and
 * each is queued for a one-time save into an alphaXiv folder named after its
 * old deck. Non-arXiv papers go. Pure, so the rule is a unit test.
 */
export function v27Papers(
  papers: readonly unknown[],
  decks: readonly unknown[],
): { papers: Paper[]; push: { id: string; folder: string }[] } {
  const deckName = new Map<string, string>();
  for (const d of decks) {
    const deck = d as { id?: unknown; name?: unknown };
    if (typeof deck?.id === 'string' && typeof deck.name === 'string') deckName.set(deck.id, deck.name);
  }
  const out: Paper[] = [];
  const push: { id: string; folder: string }[] = [];
  const seen = new Set<string>();
  for (const raw of papers) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const pdf = p.pdf as Paper['pdf'] | undefined;
    // Either link may be the arXiv one (a project page with an arXiv PDF, say).
    const id = arxivId(str(p.url)) ?? (pdf?.url ? arxivId(pdf.url) : null);
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const now = typeof p.updatedAt === 'number' ? p.updatedAt : Date.now();
    out.push({
      id,
      title: str(p.title) || id,
      authors: str(p.authors),
      year: typeof p.year === 'number' ? p.year : null,
      url: `https://arxiv.org/abs/${id}`,
      // Re-running v27 must not forget folders a sync already filled in.
      folderIds: Array.isArray(p.folderIds) ? (p.folderIds as string[]) : [],
      progressPercent: typeof p.progressPercent === 'number' ? p.progressPercent : 0,
      leftOff: str(p.leftOff),
      ...(pdf?.url ? { pdf } : {}),
      addedAt: typeof p.addedAt === 'number' ? p.addedAt : now,
      updatedAt: now,
      lastReadAt: typeof p.lastReadAt === 'number' ? p.lastReadAt : null,
    });
    push.push({ id, folder: deckName.get(str(p.deckId)) ?? 'Want to read' });
  }
  return { papers: out, push };
}

/** v27: annotations live on only for arXiv documents (docKey 'arxiv:<id>'). */
export function v27Annotations(list: readonly unknown[]): Annotation[] {
  return list.filter(
    (a): a is Annotation =>
      !!a && typeof a === 'object' && typeof (a as Annotation).docKey === 'string' && (a as Annotation).docKey.startsWith('arxiv:'),
  );
}

/** v27: a Pomodoro-shaped session (no tabIds) cannot block anything any more. */
export function v27FocusSession(session: unknown): FocusSession | null {
  const s = session as FocusSession | null | undefined;
  return s && Array.isArray(s.tabIds) && typeof s.startedAt === 'number' ? s : null;
}

async function migrateToV27(): Promise<void> {
  const { papers, decks, annotations, focusSession, alphaxivPush } = await chrome.storage.local.get([
    'papers',
    'decks',
    'annotations',
    'focusSession',
    'alphaxivPush',
  ]);
  const next = v27Papers((papers as unknown[] | undefined) ?? [], (decks as unknown[] | undefined) ?? []);
  await chrome.storage.local.set({
    papers: next.papers,
    // Written once: a re-run (decks already swept) must not rewrite a queue the sync is draining.
    alphaxivPush: Array.isArray(alphaxivPush) ? alphaxivPush : next.push,
    annotations: v27Annotations((annotations as unknown[] | undefined) ?? []),
    focusSession: v27FocusSession(focusSession),
  });
  await chrome.storage.session.remove(V27_DEAD_SESSION_KEYS);
}

/**
 * v23 → v24: the brain dump stopped sorting and stepping. Points it sorted a
 * dump into are dropped; each original dump keeps only its words, which get
 * sealed into the vault at first-time setup.
 */
export function v24Dumps(list: readonly unknown[]): Dump[] {
  return (list as Partial<Dump & { parentId: string }>[])
    .filter((d) => !d.parentId && typeof d.text === 'string')
    .map((d) => ({ id: d.id ? String(d.id) : crypto.randomUUID(), text: d.text!, createdAt: Number(d.createdAt) || 0 }));
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
  // v23: the new tab's daily focus line
  'focusOfDay',
  // v25: minimal revamp
  'weather',
  'bookmarks',
  'bookmarkGroups',
  'aiStats',
  // v27: papers library
  'feeds',
  'readItems',
  'cachedItems',
  'cacheTimestamp',
  'readingProgress',
  'aiVectors',
  'layaRoles',
  'provocations',
  'decks',
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
  // v25: minimal revamp
  'hyperfocusEnabled',
  'focusMusicEnabled',
  'geminiKey',
  'nudgesEnabled',
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
  // v23: Pomodoro could never be started, so its break length was never read
  'focusBreakMinutes',
  // v25: minimal revamp
  'displayName',
  'weatherLocation',
  'ambientMotion',
  // v27: papers library
  'refreshInterval',
  'focusMinutes',
  'breakMinutes',
  'focusSound',
  'semanticScholarApiKey',
  'ollamaUrl',
  'ollamaChatModel',
  'ollamaEmbedModel',
  'cloudMode',
  'layaUrl',
  'mutedTopics',
  'trackTopics',
  'geminiTopicKey',
  'notificationsEnabled',
  // v28: one walnut theme
  'theme',
  'readerNight',
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
