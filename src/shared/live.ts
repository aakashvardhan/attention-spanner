/**
 * Live mode session state — pure types and reducers. All IO lives in
 * src/background/live.ts, matching the split in recordings.ts.
 *
 * Deliberately separate from the Recording record, and deliberately in
 * chrome.storage.session. A transcript is an artifact worth keeping; a
 * suggested answer is coaching for a moment that has already passed. Keeping
 * them apart means live mode can't grow the durable store, can't push a
 * recording past MAX_RECORDINGS, and never reaches the sync layer.
 */

/**
 * When to answer without being asked. Mirrors Pluely's three trigger modes:
 * 'question' fires only when someone asks something, 'pause' fires on every
 * transcribed segment, 'manual' never fires on its own.
 */
export type LiveMode = 'question' | 'pause' | 'manual';

/** How eagerly to answer — the minimum gap between suggestions. */
export type LivePace = 'fast' | 'balanced' | 'relaxed';

export interface LiveAnswer {
  id: string;
  /** The detected question, or '' when a pause or a manual tap triggered it */
  question: string;
  text: string;
  /** Offset into the recording, so an answer can be lined up with the transcript */
  atSec: number;
  createdAt: number;
  /** One-tap follow-ups generated from the answer; absent until they land */
  followUps?: string[];
}

export interface LiveSession {
  /** The recording this is attached to; '' when live mode is idle */
  recordingId: string;
  mode: LiveMode;
  pace: LivePace;
  /** Pinned skill id — the "listen mode tab". '' = ordinary keyword selection. */
  skillId: string;
  answers: LiveAnswer[];
  /** Dispatch time of the most recent answer — the cooldown's basis */
  lastAnswerAt: number;
  /**
   * Hashes of questions already answered. A question echoed by two speakers, or
   * split across a segment boundary and transcribed twice, should cost one call.
   */
  answered: string[];
  /** An answer is in flight — blocks the overlap Pluely queues around */
  busy: boolean;
  error: string;
  /**
   * What this session cost, in requests. Counted rather than estimated: how
   * much the gates and the cache actually save depends entirely on the meeting,
   * so the only honest number is a measured one.
   */
  stats: LiveStats;
}

export interface LiveStats {
  /** Answer requests actually sent */
  answers: number;
  /** Follow-up chip requests actually sent */
  chips: number;
  /** Requests avoided by a cache hit */
  cacheHits: number;
}

/** Newest-wins cap. Session storage is small and answers age out of usefulness fast. */
export const MAX_LIVE_ANSWERS = 30;
/** Enough history to catch a repeat within a meeting without unbounded growth */
export const MAX_ANSWERED_HASHES = 60;
/** Follow-up chips per answer. Three is the most you can scan without reading. */
export const MAX_FOLLOWUPS = 3;

/**
 * Pluely's "listen mode tabs": what kind of room you're in, which changes what
 * a useful answer looks like. Built in rather than seeded into assistantSkills
 * — they need no migration, can't be half-deleted, and leave the user's own
 * skill list alone. A `skillId` matching a preset id wins; anything else is
 * looked up among the user's skills.
 */
export interface ListenPreset {
  id: string;
  name: string;
  body: string;
}

export const LISTEN_PRESETS: readonly ListenPreset[] = [
  {
    id: 'preset:general',
    name: 'General',
    body: 'Answer plainly. Prefer the concrete fact or number over the general principle.',
  },
  {
    id: 'preset:interview',
    name: 'Interview',
    body:
      'The user is being interviewed. Give them the substance of an answer — the ' +
      'structure, the example, the number — not a script to read aloud. If a ' +
      'question is behavioural, name the situation-action-result shape in one line ' +
      'and leave the content to them.',
  },
  {
    id: 'preset:meeting',
    name: 'Meeting',
    body:
      'Lead with anything asked of the user directly, then decisions made. Flag ' +
      'commitments with who owes what. Ignore small talk entirely.',
  },
  {
    id: 'preset:lecture',
    name: 'Lecture',
    body:
      'Explain the concept just mentioned, briefly, assuming the user missed the ' +
      'setup. Define jargon on first use. Use LaTeX for any mathematics.',
  },
];

export function findPreset(id: string): ListenPreset | undefined {
  return LISTEN_PRESETS.find((p) => p.id === id);
}

export function newLiveSession(recordingId: string, mode: LiveMode = 'question'): LiveSession {
  return {
    recordingId,
    mode,
    pace: 'balanced',
    skillId: '',
    answers: [],
    lastAnswerAt: 0,
    answered: [],
    busy: false,
    error: '',
    stats: { answers: 0, chips: 0, cacheHits: 0 },
  };
}

/** Tally one request, or one avoided. */
export function countLive(session: LiveSession, kind: keyof LiveStats): LiveSession {
  return { ...session, stats: { ...session.stats, [kind]: session.stats[kind] + 1 } };
}

/** The idle session — live mode off, nothing attached. */
export function idleLiveSession(): LiveSession {
  return newLiveSession('');
}

export function isLiveActive(session: LiveSession): boolean {
  return session.recordingId !== '';
}

/**
 * Record a dispatched answer: appended newest-last, cooldown clock reset, and
 * the question hash remembered so a repeat is suppressed rather than re-billed.
 */
export function appendLiveAnswer(
  session: LiveSession,
  answer: LiveAnswer,
  questionHash: string,
  now: number,
): LiveSession {
  return {
    ...session,
    answers: [...session.answers, answer].slice(-MAX_LIVE_ANSWERS),
    lastAnswerAt: now,
    answered: questionHash
      ? [...session.answered.filter((h) => h !== questionHash), questionHash].slice(
          -MAX_ANSWERED_HASHES,
        )
      : session.answered,
    busy: false,
    error: '',
  };
}

/** Attach follow-up chips to an answer that has already landed. */
export function attachFollowUps(
  session: LiveSession,
  answerId: string,
  followUps: string[],
): LiveSession {
  return {
    ...session,
    answers: session.answers.map((a) => (a.id === answerId ? { ...a, followUps } : a)),
  };
}

export function setLiveMode(session: LiveSession, mode: LiveMode): LiveSession {
  return { ...session, mode };
}

export function setLivePace(session: LiveSession, pace: LivePace): LiveSession {
  return { ...session, pace };
}

export function pinLiveSkill(session: LiveSession, skillId: string): LiveSession {
  return { ...session, skillId };
}

/** Claim/release the in-flight slot. Releasing on failure also records why. */
export function setLiveBusy(session: LiveSession, busy: boolean, error = ''): LiveSession {
  return { ...session, busy, error };
}
