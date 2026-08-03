import { LIVE_WINDOW_SEC } from '../constants';
import type { LivePace } from '../live';
import type { TranscriptSegment } from '../recordings';
import { formatTimestamp } from '../recordings';
import { hash32, normalizeUtterance } from './cache';
import { QUESTION_RE } from './heuristics';

/**
 * When a live segment is worth an API call, and what to send. The mirror of
 * vision.ts's shouldCapture: the background writer owns the clock and the
 * network, this file owns the decisions, which keeps them testable.
 *
 * Every gate here is a cost gate as much as a quality one. An answer nobody
 * asked for is both noise on screen and a billed request.
 */

/**
 * Minimum gap between answers, from Pluely's pace tiers. 'fast' keeps up with an
 * interview; 'relaxed' is for a lecture where you want the occasional note, not
 * a running commentary.
 */
export const PACE_MIN_GAP_MS: Record<LivePace, number> = {
  fast: 5_000,
  balanced: 15_000,
  relaxed: 40_000,
};

/**
 * Conversational asks that carry no question mark. Live transcripts are largely
 * unpunctuated, so the '?' test alone misses most of what is actually a question
 * directed at you — "walk me through your experience" being the canonical case.
 */
const ASK_RE =
  /\b(?:walk\s+(?:me|us)\s+through|tell\s+(?:me|us)\s+about|talk\s+(?:me|us)\s+through|explain\s+(?:to\s+)?(?:me|us|why|how|what)|describe\s+(?:to\s+)?(?:me|us)?|what\s+would\s+you|how\s+would\s+you|why\s+would\s+you|what\s+do\s+you\s+think|any\s+thoughts|thoughts\s+on|can\s+you\s+(?:tell|explain|describe|walk|give)|could\s+you\s+(?:tell|explain|describe|walk|give)|give\s+(?:me|us)\s+an?\s+example)\b/;

/** Interrogative openers, for a sentence with its punctuation stripped away. */
const OPENER_RE =
  /^(?:who|what|whats|what's|when|where|why|how|hows|how's|which|whose|can|could|would|should|will|do|does|did|is|are|was|were|have|has|had|any)\b/;

/**
 * Discourse fillers that precede the actual opener in speech. Nobody says "how
 * do you handle retries" — they say "okay so how do you handle retries", and an
 * anchored opener test would miss every one of them.
 */
const FILLER_RE = /^(?:(?:okay|ok|so|um|uh|erm|and|but|well|right|yeah|yes|no|now|then|like|i\s+mean|sorry|hey|alright)[\s,]+)+/;

/** Split a chunk of transcript into sentence-ish pieces. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The question this segment ends on, or null. Scans backwards because the most
 * recent ask is the one still hanging in the air — an earlier one in the same
 * segment has already been answered by whoever was speaking. Pure.
 */
export function detectQuestion(text: string): string | null {
  const parts = sentences(text);
  for (let i = parts.length - 1; i >= 0; i--) {
    const raw = parts[i];
    const bare = raw.replace(/[.!?]+$/, '').trim();
    if (bare.length < 6) continue;
    const lower = bare.toLowerCase();
    // Neither a speaker label ("Speaker 2: what about latency") nor a run of
    // fillers should hide the opener behind them.
    const spoken = lower.replace(/^speaker\s*\d+\s*:\s*/, '').replace(FILLER_RE, '');
    // The bare opener test is loose enough to read "Now is the time to ship." as
    // a question once "now" is stripped. So it only applies where punctuation is
    // absent and therefore carries no information; a sentence the transcriber
    // ended with a period is taken at its word. The specific patterns below run
    // either way — "walk me through your experience." is an ask whatever it ends
    // with, and being narrow is what earns them that.
    const unpunctuated = !/[.!?]$/.test(raw);
    if (
      raw.endsWith('?') ||
      QUESTION_RE.test(spoken) ||
      ASK_RE.test(spoken) ||
      (unpunctuated && OPENER_RE.test(spoken))
    ) {
      return bare.replace(/^[Ss]peaker\s*\d+\s*:\s*/, '');
    }
  }
  return null;
}

export interface AnswerGate {
  msSinceLastAnswer: number;
  pace: LivePace;
  /** An answer is already in flight */
  busy: boolean;
  /** This exact question has been answered before in this session */
  duplicate: boolean;
}

/**
 * Answer this one? Every false here is a request not made. Duplicate
 * suppression is the one that matters most: a question echoed by a second
 * speaker, or split across a segment boundary and transcribed twice, would
 * otherwise be billed twice for the same answer. Pure.
 */
export function shouldAutoAnswer(gate: AnswerGate): boolean {
  if (gate.busy || gate.duplicate) return false;
  return gate.msSinceLastAnswer >= PACE_MIN_GAP_MS[gate.pace];
}

/**
 * The trailing slice of transcript sent as context — recent speech only, since
 * a live answer is about what is being said now and a longer window is just a
 * larger bill. Timestamped for the same reason the summarizer's is. Pure.
 */
export function recentWindow(
  segments: TranscriptSegment[],
  nowSec: number,
  windowSec = LIVE_WINDOW_SEC,
): string {
  const since = nowSec - windowSec;
  return segments
    .filter((s) => s.endSec >= since && s.text.trim() !== '')
    .map((s) => `[${formatTimestamp(s.startSec)}] ${s.text.trim()}`)
    .join('\n\n');
}

/**
 * Cache key for a live answer. The pinned skill is part of it because the same
 * question under the Interview tab and the Meeting tab is a different answer.
 */
export function liveAnswerCacheKey(question: string, skillId: string): string {
  return `live:${hash32(`${normalizeUtterance(question)}|${skillId}`)}`;
}

/** Dedup key for the answered-questions list. */
export function questionHash(question: string): string {
  return hash32(normalizeUtterance(question));
}
