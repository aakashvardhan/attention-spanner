import {
  LIVE_ANSWER_MAX_CHARS,
  LIVE_ANSWER_TIMEOUT_MS,
  LIVE_WINDOW_SEC,
} from '../shared/constants';
import {
  appendLiveAnswer,
  attachFollowUps,
  countLive,
  findPreset,
  idleLiveSession,
  isLiveActive,
  MAX_FOLLOWUPS,
  newLiveSession,
  pinLiveSkill,
  setLiveBusy,
  setLiveMode,
  setLivePace,
  type LiveAnswer,
  type LiveMode,
  type LivePace,
  type LiveSession,
} from '../shared/live';
import { getLocal, getSession, getSettings, setSession } from '../shared/storage';
import type { Settings } from '../shared/types';
import { parseJsonObject } from '../shared/ai/assistant';
import { cacheGet, cacheSet, hash32, LIVE_CACHE_TTL_MS } from '../shared/ai/cache';
import { cloudProviderFor, hasCloudKey } from '../shared/ai/cloud';
import {
  detectQuestion,
  liveAnswerCacheKey,
  questionHash,
  recentWindow,
  shouldAutoAnswer,
} from '../shared/ai/liveTriggers';
import { buildSkillBlock, loadSkills } from '../shared/ai/skills';
import { newTurn } from '../shared/ai/assistantTypes';
import type { TranscriptSegment } from '../shared/recordings';

/**
 * Live mode's single writer, in the same spirit as recordings.ts: every
 * mutation of `liveSession` goes through this file so two segments landing at
 * once can't interleave a read-modify-write.
 *
 * The cost discipline lives here. A live recording issues an answer request
 * every few seconds if nothing stops it, so this module is mostly gates: is
 * anyone listening, was that actually a question, have we answered it already,
 * is one already in flight, and has enough time passed. Each one is a request
 * not made.
 */

/** Read → mutate → write. Callers pass a pure reducer over the session. */
async function patchLive(fn: (session: LiveSession) => LiveSession): Promise<LiveSession> {
  const { liveSession } = await getSession('liveSession');
  const next = fn(liveSession);
  await setSession({ liveSession: next });
  return next;
}

export async function startLive(recordingId: string, mode: LiveMode = 'question'): Promise<void> {
  await setSession({ liveSession: newLiveSession(recordingId, mode) });
}

export async function stopLive(): Promise<void> {
  const { liveSession } = await getSession('liveSession');
  if (isLiveActive(liveSession)) {
    const { answers, chips, cacheHits } = liveSession.stats;
    // The other half of the recorder's segment tally: between them they are the
    // whole per-recording cost, measured rather than projected.
    console.info(
      `[live] ${answers} answer + ${chips} chip requests, ${cacheHits} served from cache`,
    );
  }
  await setSession({ liveSession: idleLiveSession() });
}

export async function setMode(mode: LiveMode): Promise<void> {
  await patchLive((s) => setLiveMode(s, mode));
}

export async function setPace(pace: LivePace): Promise<void> {
  await patchLive((s) => setLivePace(s, pace));
}

export async function pinSkill(skillId: string): Promise<void> {
  await patchLive((s) => pinLiveSkill(s, skillId));
}

/**
 * A segment just landed. Decide whether it deserves an answer.
 *
 * Called from handleSegmentReady, which owns the transcript write — this runs
 * after it so the window we send already includes the segment that triggered it.
 */
export async function onLiveSegment(recordingId: string, text: string, endSec: number): Promise<void> {
  const { liveSession } = await getSession('liveSession');
  if (!isLiveActive(liveSession) || liveSession.recordingId !== recordingId) return;
  if (liveSession.mode === 'manual') return;

  const question = liveSession.mode === 'question' ? detectQuestion(text) : null;
  // In question mode a segment with nothing being asked is the common case, and
  // returning here is the difference between a few answers and one per segment.
  if (liveSession.mode === 'question' && !question) return;

  await answer(liveSession, question ?? '', endSec);
}

/** The Suggest button: answer now, whatever the mode, using recent speech. */
export async function suggestNow(): Promise<void> {
  const { liveSession } = await getSession('liveSession');
  if (!isLiveActive(liveSession)) return;
  const segments = await segmentsFor(liveSession.recordingId);
  const endSec = segments.length ? segments[segments.length - 1].endSec : 0;
  // An explicit tap bypasses the pace gate — the user asked, so make the call.
  await answer(liveSession, detectQuestion(lastText(segments)) ?? '', endSec, true);
}

/** A follow-up chip or a typed question, answered against the same window. */
export async function askLive(question: string): Promise<void> {
  const { liveSession } = await getSession('liveSession');
  if (!isLiveActive(liveSession) || !question.trim()) return;
  const segments = await segmentsFor(liveSession.recordingId);
  const endSec = segments.length ? segments[segments.length - 1].endSec : 0;
  await answer(liveSession, question.trim(), endSec, true);
}

function lastText(segments: TranscriptSegment[]): string {
  return segments.length ? segments[segments.length - 1].text : '';
}

async function segmentsFor(recordingId: string): Promise<TranscriptSegment[]> {
  const { recordings } = await getLocal('recordings');
  return recordings.find((r) => r.id === recordingId)?.segments ?? [];
}

/**
 * Generate one answer, subject to every gate. `force` skips only the pace
 * cooldown (a manual tap), never the busy check — two in-flight requests would
 * race to write the session.
 */
async function answer(
  session: LiveSession,
  question: string,
  atSec: number,
  force = false,
): Promise<void> {
  const hash = question ? questionHash(question) : '';
  const gate = {
    msSinceLastAnswer: Date.now() - session.lastAnswerAt,
    pace: session.pace,
    busy: session.busy,
    duplicate: hash !== '' && session.answered.includes(hash),
  };
  if (gate.busy) return;
  if (!force && !shouldAutoAnswer(gate)) return;
  // A duplicate is suppressed even when forced: the answer is already on screen.
  if (force && gate.duplicate) return;

  const settings = await getSettings();
  if (!hasCloudKey(settings)) return;

  const segments = await segmentsFor(session.recordingId);
  const transcript = recentWindow(segments, atSec, LIVE_WINDOW_SEC);
  if (!transcript.trim()) return;

  const system = LIVE_PERSONA + buildSkillBlock(await pinnedBlock(session.skillId));

  // Cached before anything is claimed: a repeat costs nothing and shouldn't
  // even take the in-flight slot.
  const key = liveAnswerCacheKey(question || transcript.slice(-200), session.skillId);
  const cached = await cacheGet<string>(key);
  if (cached) {
    await patchLive((s) => countLive(s, 'cacheHits'));
    await record(session.recordingId, question, cached, atSec, hash);
    return;
  }

  await patchLive((s) => countLive(setLiveBusy(s, true), 'answers'));
  try {
    const reply = await cloudProviderFor(settings).generate({
      system,
      // The transcript rides in the user turn, never in `system`. That keeps the
      // system block byte-identical across a session, which is what makes
      // Anthropic's cache_control breakpoint (and Gemini's implicit prefix
      // caching) actually hit on every call after the first.
      turns: [newTurn('user', buildLivePrompt(question, transcript))],
      signal: AbortSignal.timeout(LIVE_ANSWER_TIMEOUT_MS),
    });
    const text = reply.text.trim().slice(0, LIVE_ANSWER_MAX_CHARS);
    if (!text) {
      await patchLive((s) => setLiveBusy(s, false));
      return;
    }
    await cacheSet(key, text, LIVE_CACHE_TTL_MS, 'live');
    await record(session.recordingId, question, text, atSec, hash);
  } catch (error) {
    // A failed suggestion is a non-event — the meeting carries on, and the next
    // segment gets its own chance. Kept only so the panel can say why.
    console.error('[live] answer failed', error);
    await patchLive((s) => setLiveBusy(s, false, (error as Error)?.message || 'Answer failed.'));
  }
}

async function record(
  recordingId: string,
  question: string,
  text: string,
  atSec: number,
  hash: string,
): Promise<void> {
  const now = Date.now();
  const entry: LiveAnswer = {
    id: `${recordingId}:${now}`,
    question,
    text,
    atSec,
    createdAt: now,
  };
  await patchLive((s) =>
    // The session can have been stopped or re-pointed while the request was in
    // flight; dropping the answer is better than attaching it to a new meeting.
    s.recordingId === recordingId ? appendLiveAnswer(s, entry, hash, now) : s,
  );
  // Chips are a nicety — the answer is already on screen, so a failure here is
  // silent and never blocks the caller.
  void addFollowUps(recordingId, entry.id, question, text).catch(() => undefined);
}

const FOLLOWUP_SCHEMA = {
  type: 'object',
  required: ['followUps'],
  additionalProperties: false,
  properties: {
    followUps: {
      type: 'array',
      maxItems: MAX_FOLLOWUPS,
      items: { type: 'string', maxLength: 60 },
    },
  },
};

/**
 * Pluely's follow-up chips: the two or three things you'd naturally ask next.
 * Cached on the answer, not the question — the same answer text always earns
 * the same chips, and a cache hit here is a request saved every repeat.
 */
async function addFollowUps(
  recordingId: string,
  answerId: string,
  question: string,
  answer: string,
): Promise<void> {
  const settings = await getSettings();
  if (!hasCloudKey(settings)) return;

  const key = `livechips:${hash32(answer)}`;
  const cached = await cacheGet<string[]>(key);
  if (!cached) await patchLive((s) => countLive(s, 'chips'));
  const chips = cached ?? (await generateFollowUps(settings, question, answer));
  if (chips.length === 0) return;
  if (!cached) await cacheSet(key, chips, LIVE_CACHE_TTL_MS, 'live');
  else await patchLive((s) => countLive(s, 'cacheHits'));

  await patchLive((s) =>
    s.recordingId === recordingId ? attachFollowUps(s, answerId, chips) : s,
  );
}

async function generateFollowUps(
  settings: Settings,
  question: string,
  answer: string,
): Promise<string[]> {
  const reply = await cloudProviderFor(settings).generate({
    system:
      `Suggest at most ${MAX_FOLLOWUPS} follow-up questions someone in this ` +
      'conversation would plausibly ask next. Each is a short question in their ' +
      'own voice, under 60 characters, no numbering and no emoji.',
    turns: [
      newTurn(
        'user',
        `${question ? `They asked: "${question}"\n\n` : ''}The answer given was:\n\n${answer}`,
      ),
    ],
    responseSchema: FOLLOWUP_SCHEMA,
    signal: AbortSignal.timeout(LIVE_ANSWER_TIMEOUT_MS),
  });
  const parsed = parseJsonObject(reply.text);
  const list = Array.isArray(parsed.followUps) ? parsed.followUps : [];
  return list
    .filter((f): f is string => typeof f === 'string' && f.trim() !== '')
    .map((f) => f.trim().slice(0, 60))
    .slice(0, MAX_FOLLOWUPS);
}

/**
 * "I zoned out — what did I miss?" The feature Pluely doesn't have and the one
 * this extension exists for. Summarizes the tail of the transcript rather than
 * answering a question, so it deliberately skips the pace gate and the
 * duplicate check: asking twice means you missed it twice.
 */
export async function catchMeUp(minutes = 5): Promise<string> {
  const { liveSession } = await getSession('liveSession');
  if (!isLiveActive(liveSession)) return 'Nothing is being recorded right now.';

  const settings = await getSettings();
  if (!hasCloudKey(settings)) return 'Add a Gemini or Anthropic API key in Settings → Assistant.';

  const segments = await segmentsFor(liveSession.recordingId);
  const endSec = segments.length ? segments[segments.length - 1].endSec : 0;
  const transcript = recentWindow(segments, endSec, minutes * 60);
  if (!transcript.trim()) return 'Nothing has been transcribed yet.';

  // Keyed on how much transcript exists, so tapping twice without new speech is
  // free — which is exactly what happens when the button is the one you reach
  // for whenever you resurface.
  const key = `livecatchup:${hash32(`${liveSession.recordingId}|${segments.length}|${minutes}`)}`;
  const cached = await cacheGet<string>(key);
  if (cached) {
    await patchLive((s) => countLive(s, 'cacheHits'));
    await record(liveSession.recordingId, CATCH_UP_LABEL, cached, endSec, '');
    return cached;
  }
  await patchLive((s) => countLive(s, 'answers'));

  const reply = await cloudProviderFor(settings).generate({
    system:
      'Summarize what was just said for someone who lost the thread and needs to ' +
      'rejoin without asking anyone to repeat themselves. At most four bullets, ' +
      'each one sentence. Lead with any decision made or anything asked of them. ' +
      'Only what the transcript says — no invented names, numbers or conclusions.',
    turns: [newTurn('user', `Transcript of the last ${minutes} minutes:\n\n${transcript}`)],
    signal: AbortSignal.timeout(LIVE_ANSWER_TIMEOUT_MS),
  });
  const text = reply.text.trim().slice(0, LIVE_ANSWER_MAX_CHARS);
  if (!text) return 'Could not summarize that.';
  await cacheSet(key, text, LIVE_CACHE_TTL_MS, 'live');
  // Recorded as well as returned, so the panel shows it whichever way it was
  // asked for — a spoken "what did I miss" and the button land in the same place.
  await record(liveSession.recordingId, CATCH_UP_LABEL, text, endSec, '');
  return text;
}

const CATCH_UP_LABEL = 'What you missed';

/**
 * The pinned "listen mode tab" — a built-in preset, or one of the user's own
 * skills by id. Returned as a list because that is what buildSkillBlock takes;
 * an unset or stale id yields none, and the persona stands alone.
 */
async function pinnedBlock(skillId: string): Promise<{ name: string; body: string }[]> {
  if (!skillId) return [];
  const preset = findPreset(skillId);
  if (preset) return [{ name: preset.name, body: preset.body }];
  const skill = (await loadSkills()).find((s) => s.id === skillId && s.body.trim() !== '');
  return skill ? [{ name: skill.name, body: skill.body }] : [];
}

const LIVE_PERSONA =
  'You are helping someone who is in a live meeting, interview or lecture right now. ' +
  'They can only glance at you, so answer in at most three short sentences or three ' +
  'bullets — no preamble, no restating the question, no emoji. ' +
  'Answer only from the transcript and what you reliably know; if the transcript does ' +
  'not contain what is needed, say so in one line rather than guessing. ' +
  'The transcript is machine-generated and may have misheard technical terms — keep its ' +
  'wording rather than silently correcting it, and flag a term that looks garbled. ' +
  'Never invent names, numbers, dates or citations.';

/** Pure — exported for tests. */
export function buildLivePrompt(question: string, transcript: string): string {
  const ask = question
    ? `Someone just asked: "${question}"\n\nAnswer it.`
    : 'Give one short, useful observation or the answer to whatever was just asked.';
  return `Recent transcript:\n\n${transcript}\n\n---\n\n${ask}`;
}
